package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
)

func flagStr(a cmdArgs, key string) string {
	switch v := a.flags[key].(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func flagBool(a cmdArgs, key string) bool {
	v, _ := a.flags[key].(bool)
	return v
}

func flagInt(a cmdArgs, key string, def int) int {
	switch v := a.flags[key].(type) {
	case float64:
		return int(v)
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// cliOnlyFlags are consumed by the CLI itself and never forwarded to the extension.
var cliOnlyFlags = map[string]bool{"grep": true, "diff": true, "out": true, "region": true, "save": true, "clip": true}

/** Starts a payload from every non-CLI flag, so extension options without a dedicated CLI flag (--quality, --focus, ...) still reach it. */
func passthrough(a cmdArgs) map[string]any {
	p := make(map[string]any, len(a.flags))
	for k, v := range a.flags {
		if !cliOnlyFlags[k] {
			p[k] = v
		}
	}
	return p
}

func setDefault(p map[string]any, key string, value any) {
	if _, ok := p[key]; !ok {
		p[key] = value
	}
}

func posOrFlag(a cmdArgs, i int, key string) string {
	if v := flagStr(a, key); v != "" {
		return v
	}
	if i < len(a.pos) {
		return a.pos[i]
	}
	return ""
}

func cmdStatus(s *session, a cmdArgs) (output, error) {
	status, err := s.statusMap()
	var be *extbridge.BridgeError
	if err != nil && !errors.As(err, &be) {
		return output{}, notRunningError(err)
	}
	if err != nil {
		return output{}, err
	}
	// status only blocks for the extension when explicitly asked to with --wait.
	if status["extensionConnected"] != true && s.g.waitSet {
		if err := s.waitForExtension(); err != nil {
			return output{}, err
		}
		status, _ = s.statusMap()
	}
	cfg := extbridge.NormalizeConfig(s.g.cfg)
	status["bridge"] = cfg.BaseURL
	if status["extensionConnected"] != true {
		if reason := unpairedReason(status); reason != "" {
			return output{}, &cmdError{Message: reason, Hint: pairingHint}
		}
		return output{}, &cmdError{
			Message: "bridge is up at " + cfg.BaseURL + " but the extension is not connected",
			Hint:    "Open Chrome with the BrowserControl extension and pair it with the token from 'browsercontrol token'; 'status --wait 20s' waits for the reconnect.",
		}
	}
	text := "ok: extension connected via " + cfg.BaseURL
	if v, _ := status["extensionVersion"].(string); v != "" {
		text += " (extension v" + v + ")"
	}
	return output{data: status, text: text}, nil
}

func cmdServe(s *session, a cmdArgs) (output, error) {
	server, info, err := extbridge.NewServer(s.g.cfg)
	if err != nil {
		return output{}, err
	}
	cfg := extbridge.NormalizeConfig(s.g.cfg)
	fmt.Fprintf(os.Stderr, "bridge listening on %s (token: %s); keep this running, then open/reload the extension\n", cfg.BaseURL, info.Source)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.ListenAndServe(ctx); err != nil {
		return output{}, err
	}
	return output{data: map[string]any{"stopped": true, "bridge": cfg.BaseURL}, text: "bridge stopped"}, nil
}

func cmdToken(s *session, _ cmdArgs) (output, error) {
	info, err := extbridge.LoadToken(s.g.cfg)
	if err != nil {
		return output{}, err
	}
	return output{data: info, text: info.Token}, nil
}

func cmdExec(s *session, a cmdArgs) (output, error) {
	if len(a.pos) == 0 {
		return output{}, usagef("usage: browsercontrol exec <command> [key=value|--flag value|@payload.json|{json}]")
	}
	payload, err := extbridge.ParsePayloadArgs(a.pos[1:])
	if err != nil {
		return output{}, usagef("%v", err)
	}
	for k, v := range passthrough(a) {
		payload[k] = v
	}
	cmd := strings.ReplaceAll(a.pos[0], "-", "_")
	res, err := s.call(cmd, payload)
	if err != nil {
		return output{}, err
	}
	if _, err := extractBinary(res, artifactDir(), cmd, flagStr(a, "out")); err != nil {
		return output{}, err
	}
	return generic(res), nil
}

func normalizeURL(raw string) string {
	if raw == "" || strings.Contains(raw, "://") || strings.HasPrefix(raw, "about:") || strings.HasPrefix(raw, "data:") {
		return raw
	}
	if strings.HasPrefix(raw, "localhost") || strings.HasPrefix(raw, "127.0.0.1") {
		return "http://" + raw
	}
	return "https://" + raw
}

func cmdOpen(s *session, a cmdArgs) (output, error) {
	target := normalizeURL(posOrFlag(a, 0, "url"))
	if target == "" {
		return output{}, usagef("usage: browsercontrol open <url> [--new-tab] [--background]")
	}
	p := passthrough(a)
	p["url"] = target
	res, err := s.call("navigate", p)
	if err != nil {
		return output{}, err
	}
	return output{data: res, text: fmt.Sprintf("ok: tab %v at %s", num(res["tabId"]), target)}, nil
}

func cmdHistory(expression string) handler {
	return func(s *session, a cmdArgs) (output, error) {
		if _, err := s.call("evaluate", map[string]any{"expression": expression}); err != nil {
			return output{}, err
		}
		s.waitReady()
		return output{data: map[string]any{"success": true}, text: "ok"}, nil
	}
}

/** Best-effort wait for the next document to finish loading after a script-triggered navigation. */
func (s *session) waitReady() {
	time.Sleep(250 * time.Millisecond)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		res, err := s.call("evaluate", map[string]any{"expression": "document.readyState"})
		if err == nil && res["result"] == "complete" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func cmdSnapshot(s *session, a cmdArgs) (output, error) {
	if region := flagStr(a, "region"); region != "" {
		a.pos = []string{region}
		return cmdRegion(s, a)
	}
	if flagBool(a, "semantic") || flagBool(a, "diff") {
		return semanticSnapshot(s, a)
	}
	p := passthrough(a)
	// Structured nodes rather than the extension's compactNodes string, so text runs can be merged before printing.
	p["compact"] = false
	delete(p, "semantic")
	res, err := s.call("snapshot", p)
	if err != nil {
		return output{}, err
	}
	var entries []string
	if nodes, ok := res["nodes"].([]any); ok {
		entries = formatEntries(nodes)
	} else {
		entries = splitLines(str(res["compactNodes"]))
	}
	return flatSnapshotView(entries, flagStr(a, "grep"), flagInt(a, "limit", defaultSnapshotLimit)), nil
}

func flatSnapshotView(entries []string, grep string, limit int) output {
	lines := filterLines(entries, grep, limit)
	text := strings.Join(lines.kept, "\n")
	if lines.dropped > 0 {
		text += snapshotOmitted(len(lines.kept), len(lines.kept)+lines.dropped)
	}
	if text == "" {
		text = "(no interactive or text nodes)"
	}
	return output{data: map[string]any{"nodes": lines.kept, "shown": len(lines.kept), "total": len(lines.kept) + lines.dropped, "viewFiltered": lines.dropped > 0}, text: text}
}

func semanticSnapshot(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	p["semantic"] = true
	delete(p, "diff")
	res, err := s.call("snapshot", p)
	if err != nil {
		return output{}, err
	}
	snap, _ := res["snapshot"].(map[string]any)
	if snap == nil {
		return output{}, errors.New("extension returned no semantic snapshot; no action was dispatched")
	}
	delta, _ := res["delta"].(map[string]any)
	if scope, ok := snap["scope"].(map[string]any); ok {
		if doc, _ := scope["documentId"].(string); doc != "" {
			s.state.DocumentID = doc
			tab, _ := scope["tabId"].(float64)
			s.state.TabID = int(tab)
			if err := s.state.save(); err != nil {
				return output{}, fmt.Errorf("snapshot retrieved but ref state could not be saved: %w; pass --document-id and --tab explicitly", err)
			}
		}
	}
	_, hasPrevious := delta["fromRevision"]
	if flagBool(a, "diff") && hasPrevious {
		return snapshotDeltaView(delta, flagStr(a, "grep"), flagInt(a, "limit", defaultSnapshotLimit)), nil
	}
	return semanticSnapshotView(snap, flagStr(a, "grep"), flagInt(a, "limit", defaultSnapshotLimit)), nil
}

func cmdRegion(s *session, a cmdArgs) (output, error) {
	selector := posOrFlag(a, 0, "selector")
	if selector == "" {
		return output{}, usagef("usage: browsercontrol region <css-selector>")
	}
	p := passthrough(a)
	p["selector"] = selector
	res, err := s.call("query_region", p)
	if err != nil {
		return output{}, err
	}
	return regionSnapshotView(res, flagStr(a, "grep"), flagInt(a, "limit", defaultSnapshotLimit)), nil
}

func cmdFind(s *session, a cmdArgs) (output, error) {
	query := strings.Join(a.pos, " ")
	if query == "" {
		query = flagStr(a, "query")
	}
	if query == "" {
		return output{}, usagef("usage: browsercontrol find <text|css|xpath> [--limit 10]")
	}
	p := passthrough(a)
	p["query"] = query
	setDefault(p, "limit", 10)
	res, err := s.call("find", p)
	if err != nil {
		return output{}, err
	}
	matches, _ := res["matches"].([]any)
	var lines []string
	for _, m := range matches {
		lines = append(lines, formatFindMatch(asMap(m)))
	}
	text := strings.Join(lines, "\n")
	count := num(res["count"])
	if len(matches) == 0 {
		text = fmt.Sprintf("no matches for %q", query)
	} else if c, ok := res["count"].(float64); ok && int(c) > len(matches) {
		text += fmt.Sprintf("\n(%d of %v matches shown; raise --limit)", len(matches), count)
	}
	delete(res, "message")
	return output{data: res, text: text}, nil
}

func cmdRead(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	setDefault(p, "maxChars", 12000)
	res, err := s.call("reading_mode", p)
	if err != nil {
		return output{}, err
	}
	var b strings.Builder
	if title, _ := res["title"].(string); title != "" {
		b.WriteString("# " + title + "\n\n")
	}
	if res["isArticle"] == false {
		b.WriteString("(not article-shaped; 'snapshot' or 'select <css>' may fit better)\n\n")
	}
	text, _ := res["text"].(string)
	b.WriteString(text)
	if res["truncated"] == true {
		fmt.Fprintf(&b, "\n[truncated at %v chars; raise --max-chars or use 'select <css>']", p["maxChars"])
	}
	delete(res, "message")
	return output{data: res, text: b.String()}, nil
}

func cmdSelect(s *session, a cmdArgs) (output, error) {
	target := posOrFlag(a, 0, "selector")
	if target == "" && a.flags["nodeId"] == nil {
		return output{}, usagef("usage: browsercontrol select <css-selector|nodeId> [--max-chars 8000] [--max-matches n]")
	}
	p := passthrough(a)
	if n, err := strconv.Atoi(target); err == nil {
		p["nodeId"] = n
	} else if target != "" {
		p["selector"] = target
	}
	setDefault(p, "maxChars", 8000)
	res, err := s.call("select_content", p)
	if err != nil {
		return output{}, err
	}
	blocks, _ := res["blocks"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		parts = append(parts, fmt.Sprint(b))
	}
	text := strings.Join(parts, "\n\n---\n\n")
	if len(blocks) == 0 {
		text = fmt.Sprintf("no elements matched %q", target)
	} else if c, ok := res["count"].(float64); ok && (int(c) > len(blocks) || res["truncated"] == true) {
		text += fmt.Sprintf("\n[%d of %d matches, truncated=%v]", len(blocks), int(c), res["truncated"] == true)
	}
	delete(res, "message")
	return output{data: res, text: text}, nil
}

func cmdPeek(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	if flagStr(a, "out") != "" {
		p["screenshot"] = true
	}
	setDefault(p, "screenshot", false)
	setDefault(p, "maxChars", 4000)
	res, err := s.call("peek_screen", p)
	if err != nil {
		return output{}, err
	}
	shot, err := extractBinary(res, artifactDir(), "peek", flagStr(a, "out"))
	if err != nil {
		return output{}, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "tab %v %s | %v\n", num(res["tabId"]), str(res["title"]), str(res["url"]))
	if res["permissions"] == "read_only" {
		b.WriteString("(not in the AI workspace group: read-only)\n")
	}
	if sel := str(res["selectedText"]); sel != "" {
		b.WriteString("selection: " + sel + "\n")
	}
	if shot != "" {
		b.WriteString("screenshot: " + shot + "\n")
	}
	b.WriteString("\n" + str(res["text"]))
	return output{data: res, text: b.String()}, nil
}

func cmdInspect(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	if err := s.applyTarget(p, posOrFlag(a, 0, "target"), false); err != nil {
		return output{}, err
	}
	if p["nodeId"] == nil && p["ref"] == nil {
		return output{}, usagef("usage: browsercontrol inspect <id|e-ref|css|text>")
	}
	res, err := s.call("inspect_element", p)
	if err != nil {
		return output{}, err
	}
	return generic(res), nil
}

/** Viewport by default; --full for the whole page (or inner scroll container), --target for one element, --clip for a viewport rectangle. */
func cmdScreenshot(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	p["fullPage"] = flagBool(a, "full") || flagBool(a, "fullPage")
	delete(p, "full")
	delete(p, "target")
	setDefault(p, "format", "jpeg")
	if target := flagStr(a, "target"); target != "" {
		if err := s.applyTarget(p, target, false); err != nil {
			return output{}, err
		}
	}
	if raw := flagStr(a, "clip"); raw != "" {
		clip, err := parseClip(raw)
		if err != nil {
			return output{}, err
		}
		p["clip"] = clip
	}
	res, err := s.call("screenshot", p)
	if err != nil {
		return output{}, err
	}
	path, err := extractBinary(res, artifactDir(), "shot", posOrFlag(a, 0, "out"))
	if err != nil {
		return output{}, err
	}
	if path == "" {
		return output{}, &cmdError{Message: "extension returned no image data"}
	}
	text := fmt.Sprintf("saved %s (%s", path, imageInfo(path))
	if mode := str(res["mode"]); mode != "" {
		text += ", " + mode
	}
	if pz, ok := res["pageZoom"].(float64); ok && pz != 1 {
		text += fmt.Sprintf(", browser zoom %d%%", int(pz*100+0.5))
	}
	if z, ok := res["zoom"].(float64); ok && z != 1 {
		text += fmt.Sprintf(", zoom %gx", z)
	}
	text += ", " + kb(res["bytes"]) + ")"
	if res["truncated"] == true {
		text += "\n(page taller than the capture limit; cut at the bottom — use --target/--clip for the rest)"
	}
	return output{data: res, text: text}, nil
}

/** Parses --clip "x,y,w,h" in viewport CSS px. */
func parseClip(raw string) (map[string]any, error) {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == 'x' })
	if len(parts) != 4 {
		return nil, usagef("--clip wants x,y,width,height in viewport CSS px, e.g. --clip 0,0,800,400")
	}
	keys := []string{"x", "y", "width", "height"}
	clip := map[string]any{}
	for i, part := range parts {
		n, err := parseNumber(part)
		if err != nil {
			return nil, usagef("--clip: %v", err)
		}
		clip[keys[i]] = n
	}
	return clip, nil
}

func cmdVisual(s *session, a cmdArgs) (output, error) {
	res, err := s.call("visual_snapshot", passthrough(a))
	if err != nil {
		return output{}, err
	}
	path, err := extractBinary(res, artifactDir(), "visual", posOrFlag(a, 0, "out"))
	if err != nil {
		return output{}, err
	}
	nodes, _ := res["nodes"].([]any)
	kept := filterLines(formatEntries(nodes), flagStr(a, "grep"), flagInt(a, "limit", 0)).kept
	delete(res, "message")
	return output{data: res, text: fmt.Sprintf("saved %s (%s, %s); numbered boxes = node ids of on-screen controls\n%s", path, imageInfo(path), kb(res["bytes"]), strings.Join(kept, "\n"))}, nil
}

var refPattern = regexp.MustCompile(`^e\d+$`)

/** Resolves a user-facing target into the nodeId/ref the extension expects; CSS and visible text go through find first. field prefers form controls, for typing. */
func (s *session) applyTarget(p map[string]any, target string, field bool) error {
	if target == "" || p["nodeId"] != nil || p["ref"] != nil {
		return nil
	}
	if n, err := strconv.Atoi(target); err == nil {
		p["nodeId"] = n
		return nil
	}
	if ref, ok := strings.CutPrefix(target, "ref:"); ok || refPattern.MatchString(target) {
		if !ok {
			ref = target
		}
		p["ref"] = ref
		if p["documentId"] == nil {
			if s.state.DocumentID == "" {
				return usagef("ref %q needs a document id: run 'browsercontrol snapshot --semantic' first or pass --document-id", ref)
			}
			p["documentId"] = s.state.DocumentID
			tab := p["tabId"]
			if tab == nil {
				tab = s.g.tabID
			}
			if tab != nil && num(tab) != fmt.Sprint(s.state.TabID) {
				return usagef("cached ref belongs to tab %d; take a fresh semantic snapshot for the requested tab", s.state.TabID)
			}
			if s.state.TabID == 0 {
				return usagef("cached ref has no tab scope; take a fresh semantic snapshot or pass --document-id and --tab")
			}
			p["tabId"] = s.state.TabID
		}
		return nil
	}
	var queries []string
	if sel, ok := strings.CutPrefix(target, "css:"); ok {
		queries = []string{sel}
	} else if text, ok := strings.CutPrefix(target, "text:"); ok {
		queries = textQueries(text, field)
	} else if looksLikeSelector(target) {
		queries = []string{target}
	} else {
		queries = textQueries(target, field)
	}
	for _, q := range queries {
		findPayload := map[string]any{"query": q, "limit": 2}
		if tab, ok := p["tabId"]; ok {
			findPayload["tabId"] = tab
		}
		res, err := s.call("find", findPayload)
		if err != nil {
			return err
		}
		matches, ok := res["matches"].([]any)
		count, validCount := res["count"].(float64)
		if !ok || !validCount || count < 0 || count != math.Trunc(count) || math.IsInf(count, 0) || math.IsNaN(count) {
			return &cmdError{Message: "invalid find response; action was not dispatched", Hint: "Run 'browsercontrol snapshot --semantic' and use a fresh ref."}
		}
		if count > 1 || len(matches) > 1 {
			return &cmdError{Message: fmt.Sprintf("ambiguous target %q: %g matches", target, count), Hint: "Use a unique CSS selector, a fresh semantic ref, or an explicit numeric node id."}
		}
		if len(matches) > 0 && count == 1 {
			if id, ok := asMap(matches[0])["i"].(float64); ok && id > 0 && id == math.Trunc(id) && !math.IsInf(id, 0) {
				p["nodeId"] = int(id)
				return nil
			}
		}
		if count != 0 || len(matches) != 0 {
			return &cmdError{Message: "target could not be resolved; action was not dispatched", Hint: "Run 'browsercontrol snapshot --semantic' and use a fresh ref."}
		}
	}
	return &cmdError{
		Message: fmt.Sprintf("no element matches %q", target),
		Hint:    "Run 'browsercontrol snapshot --grep <word>' or 'browsercontrol find <text>' and pass the numeric id.",
	}
}

var selectorHint = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*[#.\[:]`)

func looksLikeSelector(v string) bool {
	if v == "" {
		return false
	}
	switch v[0] {
	case '#', '.', '[', '/', '(', '*':
		return true
	}
	return selectorHint.MatchString(v) || strings.Contains(v, " > ") || structuralTags[v]
}

// Bare tag names that are almost always meant as a selector ("table", "form"), not as visible text; write text:table for the word.
var structuralTags = map[string]bool{
	"table": true, "form": true, "main": true, "nav": true, "header": true, "footer": true, "aside": true,
	"article": true, "section": true, "dialog": true, "textarea": true, "select": true, "iframe": true,
	"canvas": true, "svg": true, "video": true, "img": true, "ul": true, "ol": true, "tbody": true, "thead": true,
}

/** XPath queries for a visible-text target, most specific first; field puts form controls (by placeholder, aria-label, name or <label>) ahead of clickables. */
func textQueries(text string, field bool) []string {
	t := xpathLiteral(text)
	control := `*[self::input or self::textarea or self::select or @contenteditable="true" or @role="textbox" or @role="combobox"]`
	fields := []string{
		fmt.Sprintf("//%[1]s[contains(@placeholder, %[2]s) or contains(@aria-label, %[2]s) or @name=%[2]s]", control, t),
		fmt.Sprintf("//%[1]s[@id=//label[contains(normalize-space(.), %[2]s)]/@for]", control, t),
		fmt.Sprintf("//label[contains(normalize-space(.), %[2]s)]//%[1]s", control, t),
	}
	generic := []string{
		fmt.Sprintf(`//*[self::a or self::button or self::summary or self::label or self::option or @role="button" or @role="link" or @role="tab" or @role="menuitem" or @role="checkbox" or @role="option"][contains(normalize-space(.), %s)]`, t),
		fmt.Sprintf(`//*[contains(normalize-space(.), %[1]s)][not(*[contains(normalize-space(.), %[1]s)])]`, t),
	}
	if field {
		return append(fields, generic...)
	}
	return []string{generic[0], fields[0], fields[1], fields[2], generic[1]}
}

func xpathLiteral(s string) string {
	if !strings.Contains(s, `"`) {
		return `"` + s + `"`
	}
	if !strings.Contains(s, "'") {
		return "'" + s + "'"
	}
	parts := strings.Split(s, `"`)
	return `concat("` + strings.Join(parts, `", '"', "`) + `")`
}

func actionPayload(s *session, a cmdArgs, target string, field bool) (map[string]any, error) {
	p := passthrough(a)
	delete(p, "target")
	if err := s.applyTarget(p, target, field); err != nil {
		return nil, err
	}
	return p, nil
}

func cmdClick(s *session, a cmdArgs) (output, error) {
	target := posOrFlag(a, 0, "target")
	if target == "" && a.flags["nodeId"] == nil && a.flags["ref"] == nil {
		return output{}, usagef("usage: browsercontrol click <id|e-ref|css|text> [--confirm-risky]")
	}
	p, err := actionPayload(s, a, target, false)
	if err != nil {
		return output{}, err
	}
	return s.action("click", p)
}

func cmdType(s *session, a cmdArgs) (output, error) {
	target := flagStr(a, "target")
	rest := a.pos
	if target == "" && len(rest) > 0 {
		target, rest = rest[0], rest[1:]
	}
	text := strings.Join(rest, " ")
	if t := flagStr(a, "text"); t != "" {
		text = t
	}
	if target == "" || (text == "" && !flagBool(a, "clear")) {
		return output{}, usagef("usage: browsercontrol type <id|e-ref|css|text> <text> [--clear]   (fill = type --clear)")
	}
	p, err := actionPayload(s, a, target, true)
	if err != nil {
		return output{}, err
	}
	p["text"] = text
	return s.action("type", p)
}

func cmdFill(s *session, a cmdArgs) (output, error) {
	a.flags["clear"] = true
	return cmdType(s, a)
}

func cmdPress(s *session, a cmdArgs) (output, error) {
	key := posOrFlag(a, 0, "key")
	if key == "" {
		return output{}, usagef("usage: browsercontrol press <key> [target]   e.g. Enter, Tab, Escape, ArrowDown, Control+a")
	}
	p, err := actionPayload(s, a, posOrFlag(a, 1, "target"), true)
	if err != nil {
		return output{}, err
	}
	p["key"] = key
	return s.action("press_key", p)
}

func cmdScroll(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	delete(p, "in")
	if container := flagStr(a, "in"); container != "" {
		if err := s.applyTarget(p, container, false); err != nil {
			return output{}, err
		}
	}
	var nums []float64
	for _, v := range a.pos {
		switch strings.ToLower(v) {
		case "down":
			nums = append(nums, 800)
		case "up":
			nums = append(nums, -800)
		default:
			n, err := parseNumber(v)
			if err != nil {
				return output{}, usagef("usage: browsercontrol scroll [dy] | [dx dy] | up | down")
			}
			nums = append(nums, n)
		}
	}
	switch len(nums) {
	case 0:
		setDefault(p, "deltaY", 800)
	case 1:
		p["deltaY"] = nums[0]
	default:
		p["deltaX"], p["deltaY"] = nums[0], nums[1]
	}
	return s.action("scroll", p)
}

func cmdDrag(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	keys := []string{"fromX", "fromY", "toX", "toY"}
	for i, v := range a.pos {
		if i >= len(keys) {
			break
		}
		n, err := parseNumber(v)
		if err != nil {
			return output{}, usagef("usage: browsercontrol drag <fromX> <fromY> <toX> <toY>")
		}
		p[keys[i]] = n
	}
	if p["toX"] == nil && p["points"] == nil {
		return output{}, usagef("usage: browsercontrol drag <fromX> <fromY> <toX> <toY>")
	}
	return s.action("drag", p)
}

func (s *session) action(cmd string, p map[string]any) (output, error) {
	res, err := s.call(cmd, p)
	if err != nil {
		return output{}, err
	}
	return output{data: res, text: renderAction(res)}, nil
}

func cmdEval(s *session, a cmdArgs) (output, error) {
	expression := strings.Join(a.pos, " ")
	if e := flagStr(a, "expression"); e != "" {
		expression = e
	}
	if strings.HasPrefix(expression, "@") {
		data, err := os.ReadFile(expression[1:])
		if err != nil {
			return output{}, err
		}
		expression = string(data)
	}
	if expression == "" {
		return output{}, usagef("usage: browsercontrol eval <js-expression|@file.js>")
	}
	p := passthrough(a)
	p["expression"] = expression
	res, err := s.call("evaluate", p)
	if err != nil {
		return output{}, err
	}
	value := res["result"]
	if str, ok := value.(string); ok {
		return output{data: map[string]any{"result": value}, text: str}, nil
	}
	data, _ := json.Marshal(value)
	return output{data: map[string]any{"result": value}, text: string(data)}, nil
}

func cmdWait(s *session, a cmdArgs) (output, error) {
	cond := strings.Join(a.pos, " ")
	if cond == "" {
		return output{}, usagef("usage: browsercontrol wait <text|css|xpath|2s> [--gone] [--timeout 15s]")
	}
	if d, err := time.ParseDuration(cond); err == nil {
		time.Sleep(d)
		return output{data: map[string]any{"slept": d.String()}, text: "ok: waited " + d.String()}, nil
	}
	limit := 15 * time.Second
	if s.g.timeoutSet {
		limit = s.g.cfg.Timeout
	}
	var probe string
	switch {
	case strings.HasPrefix(cond, "/") || strings.HasPrefix(cond, "("):
		probe = fmt.Sprintf("!!document.evaluate(%s, document, null, 9, null).singleNodeValue", jsString(cond))
	case looksLikeSelector(cond) || strings.HasPrefix(cond, "css:"):
		probe = fmt.Sprintf("!!document.querySelector(%s)", jsString(strings.TrimPrefix(cond, "css:")))
	default:
		probe = fmt.Sprintf("(document.title + '\\n' + ((document.body && document.body.innerText) || '')).includes(%s)", jsString(strings.TrimPrefix(cond, "text:")))
	}
	want := !flagBool(a, "gone")
	start := time.Now()
	for {
		res, err := s.call("evaluate", map[string]any{"expression": probe})
		if err == nil && res["result"] == want {
			verb := "appeared"
			if !want {
				verb = "gone"
			}
			elapsed := time.Since(start).Round(100 * time.Millisecond)
			return output{data: map[string]any{"success": true, "elapsedMs": elapsed.Milliseconds()}, text: fmt.Sprintf("ok: %q %s after %s", cond, verb, elapsed)}, nil
		}
		if time.Since(start) > limit {
			return output{}, &cmdError{Message: fmt.Sprintf("timed out after %s waiting for %q", limit, cond), Hint: "Check 'browsercontrol peek' or 'snapshot --grep' to see what the page shows."}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func jsString(s string) string {
	data, _ := json.Marshal(s)
	return string(data)
}

func cmdTabs(s *session, a cmdArgs) (output, error) {
	sub := "list"
	if len(a.pos) > 0 {
		sub = normalizeCommandName(a.pos[0])
	}
	arg := ""
	if len(a.pos) > 1 {
		arg = a.pos[1]
	}
	switch sub {
	case "list", "ls":
		p := passthrough(a)
		if flagBool(a, "all") {
			p["scope"] = "all"
		}
		delete(p, "all")
		res, err := s.call("list_tabs", p)
		if err != nil {
			return output{}, err
		}
		tabs, _ := res["tabs"].([]any)
		var lines []string
		for _, t := range tabs {
			lines = append(lines, formatTab(asMap(t)))
		}
		text := strings.Join(lines, "\n")
		if len(tabs) == 0 {
			text = "(no tabs in the AI workspace group; 'tabs --all' lists every tab)"
		}
		return output{data: res, text: text}, nil
	case "switch", "close", "rm":
		id, err := strconv.Atoi(arg)
		if err != nil {
			return output{}, usagef("usage: browsercontrol tabs %s <tabId>", sub)
		}
		cmd := "switch_tab"
		if sub != "switch" {
			cmd = "close_tab"
		}
		res, err := s.call(cmd, map[string]any{"tabId": id})
		if err != nil {
			return output{}, err
		}
		return output{data: res, text: "ok: " + firstNonEmptyString(str(res["message"]), sub+" "+arg)}, nil
	case "new", "open":
		a.pos = a.pos[1:]
		a.flags["newTab"] = true
		return cmdOpen(s, a)
	}
	return output{}, usagef("usage: browsercontrol tabs [list [--all]|switch <id>|close <id>|new <url>]")
}

func cmdNet(s *session, a cmdArgs) (output, error) {
	sub := "list"
	if len(a.pos) > 0 {
		sub = normalizeCommandName(a.pos[0])
	}
	p := passthrough(a)
	switch sub {
	case "list", "ls", "requests":
		if len(a.pos) > 1 {
			p["filter"] = a.pos[1]
		}
		setDefault(p, "limit", 30)
		res, err := s.call("network_requests", p)
		if err != nil {
			return output{}, err
		}
		reqs, _ := res["requests"].([]any)
		var lines []string
		for _, r := range reqs {
			lines = append(lines, formatRequest(asMap(r)))
		}
		text := strings.Join(lines, "\n")
		if len(reqs) == 0 {
			text = "(no requests recorded; the log starts when the debugger attaches and resets on open)"
		}
		return output{data: res, text: text}, nil
	case "detail", "show", "get":
		if len(a.pos) < 2 && p["requestId"] == nil {
			return output{}, usagef("usage: browsercontrol net detail <requestId> [--body]")
		}
		if len(a.pos) > 1 {
			p["requestId"] = a.pos[1]
		}
		if flagBool(a, "body") {
			p["includeBody"] = true
		}
		delete(p, "body")
		res, err := s.call("network_request_detail", p)
		if err != nil {
			return output{}, err
		}
		return generic(res), nil
	case "clear":
		res, err := s.call("network_clear", p)
		if err != nil {
			return output{}, err
		}
		return output{data: res, text: "ok: network log cleared"}, nil
	case "har":
		res, err := s.call("dev_har", p)
		if err != nil {
			return output{}, err
		}
		if out := flagStr(a, "out"); out != "" {
			if err := browser.WriteJSONFile(out, res); err != nil {
				return output{}, err
			}
			return output{data: map[string]any{"path": out}, text: "saved " + out}, nil
		}
		return generic(res), nil
	}
	return output{}, usagef("usage: browsercontrol net [list [filter]|detail <id> [--body]|clear|har [--out file]]")
}

func cmdDev(s *session, a cmdArgs) (output, error) {
	if len(a.pos) == 0 {
		return output{}, usagef("usage: browsercontrol dev layout [target]|memory|process|emulate [device]|sandbox [on|off]|har")
	}
	sub := normalizeCommandName(a.pos[0])
	arg := ""
	if len(a.pos) > 1 {
		arg = a.pos[1]
	}
	p := passthrough(a)
	var cmd string
	switch sub {
	case "layout":
		cmd = "dev_layout"
		if arg != "" {
			if _, err := strconv.Atoi(arg); err == nil || refPattern.MatchString(arg) {
				if err := s.applyTarget(p, arg, false); err != nil {
					return output{}, err
				}
			} else {
				p["selector"] = arg
			}
		}
	case "memory", "process":
		cmd = "dev_" + sub
		if arg != "" {
			p["focus"] = arg
		}
	case "emulate":
		cmd = "dev_emulate"
		if arg != "" {
			p["device"] = arg
		}
	case "sandbox":
		cmd = "dev_sandbox"
		mode := firstNonEmptyString(arg, flagStr(a, "mode"), "block_mutations")
		if mode == "on" {
			mode = "block_mutations"
		}
		p["mode"] = mode
	case "har":
		cmd = "dev_har"
	default:
		return output{}, usagef("unknown dev action %q", sub)
	}
	res, err := s.call(cmd, p)
	if err != nil {
		return output{}, err
	}
	return generic(res), nil
}

/** Loads flow steps verbatim from a JSON file (bare step array or {steps, domain}) or from the saved-flow store. */
func loadFlowSource(src string) (steps []json.RawMessage, domain string, err error) {
	path := strings.TrimPrefix(src, "@")
	if data, readErr := os.ReadFile(path); readErr == nil {
		var arr []json.RawMessage
		if json.Unmarshal(data, &arr) == nil && len(arr) > 0 {
			return arr, "", nil
		}
		var doc struct {
			SchemaVersion int               `json:"schemaVersion"`
			Domain        string            `json:"domain"`
			Steps         []json.RawMessage `json:"steps"`
		}
		if err := json.Unmarshal(data, &doc); err != nil || len(doc.Steps) == 0 {
			return nil, "", fmt.Errorf("%s has no flow steps", path)
		}
		if doc.SchemaVersion != 0 && doc.SchemaVersion != 1 && doc.SchemaVersion != 2 {
			return nil, "", fmt.Errorf("unsupported flow schemaVersion %d", doc.SchemaVersion)
		}
		return doc.Steps, doc.Domain, nil
	}
	flow, err := extbridge.GetFlow(src)
	if err != nil {
		return nil, "", fmt.Errorf("no flow file %q and no saved flow with that id", src)
	}
	if flow.SchemaVersion != 0 && flow.SchemaVersion != 1 && flow.SchemaVersion != 2 {
		return nil, "", fmt.Errorf("unsupported flow schemaVersion %d", flow.SchemaVersion)
	}
	return flow.Steps, flow.Domain, nil
}

func cmdFlow(s *session, a cmdArgs) (output, error) {
	if len(a.pos) == 0 {
		return output{}, usagef("usage: browsercontrol flow run|explore <file.json|id> | record [domain] | stop [--save id] | status | list | show <id> | save <id> <file.json> | rm <id>")
	}
	sub := normalizeCommandName(a.pos[0])
	arg := ""
	if len(a.pos) > 1 {
		arg = a.pos[1]
	}
	p := passthrough(a)
	switch sub {
	case "run", "explore", "validate":
		if arg == "" {
			return output{}, usagef("usage: browsercontrol flow %s <file.json|saved-id>", sub)
		}
		steps, domain, err := loadFlowSource(arg)
		if err != nil {
			return output{}, err
		}
		steps, err = bindFlowEnvironment(steps)
		if err != nil {
			return output{}, err
		}
		p["steps"] = steps
		if domain != "" {
			setDefault(p, "domain", domain)
		}
		res, err := s.call(sub+"_flow", p)
		if err != nil {
			var ce *cmdError
			if sub != "validate" && res != nil && errors.As(err, &ce) {
				ce.Message = renderFlowReport(res, a)
				if ce.Hint == "" {
					ce.Hint = "Inspect completed steps with 'browsercontrol evidence' and take a fresh snapshot before retrying; do not replay the entire flow blindly."
				}
			}
			return output{}, err
		}
		if sub == "validate" {
			return generic(res), nil
		}
		return output{data: res, text: renderFlowReport(res, a)}, nil
	case "record", "start":
		if arg != "" {
			p["domain"] = arg
		}
		res, err := s.call("start_flow_recording", p)
		if err != nil {
			return output{}, err
		}
		return generic(res), nil
	case "stop":
		res, err := s.call("stop_flow_recording", p)
		if err != nil {
			return output{}, err
		}
		if id := firstNonEmptyString(flagStr(a, "save"), arg); id != "" {
			raw, _ := json.Marshal(res["steps"])
			var steps []json.RawMessage
			_ = json.Unmarshal(raw, &steps)
			saved, err := extbridge.SaveFlow(extbridge.Flow{ID: id, SchemaVersion: 2, Name: id, Domain: str(res["domain"]), Steps: steps})
			if err != nil {
				return output{}, err
			}
			res["savedAs"] = saved.ID
		}
		text := fmt.Sprintf("ok: stopped recording (%d steps)", len(asSlice(res["steps"])))
		if id := str(res["savedAs"]); id != "" {
			text += " saved as " + id
		}
		return output{data: res, text: text}, nil
	case "status":
		setDefault(p, "summary", !flagBool(a, "all"))
		delete(p, "all")
		res, err := s.call("flow_recording_status", p)
		if err != nil {
			return output{}, err
		}
		if p["summary"] == true {
			delete(res, "steps")
		}
		return generic(res), nil
	case "list", "ls":
		flows, err := extbridge.ListFlows()
		if err != nil {
			return output{}, err
		}
		lines := make([]string, 0, len(flows))
		for _, f := range flows {
			lines = append(lines, strings.TrimSpace(fmt.Sprintf("%s  %d steps  %s", f.ID, f.StepCount, f.Domain)))
		}
		if len(lines) == 0 {
			lines = []string{"(no saved flows in " + extbridge.FlowDir() + ")"}
		}
		return output{data: map[string]any{"flows": flows}, text: strings.Join(lines, "\n")}, nil
	case "show", "get":
		flow, err := extbridge.GetFlow(arg)
		if err != nil {
			return output{}, err
		}
		return generic(flow), nil
	case "save":
		if arg == "" || len(a.pos) < 3 {
			return output{}, usagef("usage: browsercontrol flow save <id> <file.json>")
		}
		steps, domain, err := loadFlowSource(a.pos[2])
		if err != nil {
			return output{}, err
		}
		saved, err := extbridge.SaveFlow(extbridge.Flow{ID: arg, SchemaVersion: 2, Name: firstNonEmptyString(flagStr(a, "name"), arg), Domain: firstNonEmptyString(flagStr(a, "domain"), domain), Steps: steps})
		if err != nil {
			return output{}, err
		}
		return output{data: saved, text: fmt.Sprintf("ok: saved %s (%d steps)", saved.ID, saved.StepCount)}, nil
	case "rm", "delete":
		if err := extbridge.DeleteFlow(arg); err != nil {
			return output{}, err
		}
		return output{data: map[string]any{"deleted": arg}, text: "ok: deleted " + arg}, nil
	}
	return output{}, usagef("unknown flow action %q", sub)
}

func cmdSearch(s *session, a cmdArgs) (output, error) {
	query := strings.Join(a.pos, " ")
	if query == "" {
		return output{}, usagef("usage: browsercontrol search <query> [--limit 8]")
	}
	p := passthrough(a)
	p["query"] = query
	setDefault(p, "limit", 8)
	res, err := s.call("web_search", p)
	if err != nil {
		return output{}, err
	}
	results, _ := res["results"].([]any)
	var b strings.Builder
	for i, r := range results {
		m := asMap(r)
		fmt.Fprintf(&b, "%d. %s\n   %s\n", i+1, str(m["title"]), str(m["url"]))
		if snippet := str(m["snippet"]); snippet != "" {
			b.WriteString("   " + truncate(snippet, 200) + "\n")
		}
	}
	text := b.String()
	if len(results) == 0 {
		text = firstNonEmptyString(cliHint(str(res["message"])), "no results")
	}
	return output{data: map[string]any{"results": results}, text: text}, nil
}

/** Reads each URL in its own background tab (navigate → reading_mode → close), a few at a time. */
func cmdCrawl(s *session, a cmdArgs) (output, error) {
	urls := expandURLArgs(a.pos)
	if len(urls) == 0 {
		return output{}, usagef("usage: browsercontrol crawl <url...|@urls.txt> [--concurrency 3] [--max-chars 4000]")
	}
	if err := s.ensureReady(); err != nil {
		return output{}, err
	}
	concurrency := min(8, max(1, flagInt(a, "concurrency", 3)))
	maxChars := flagInt(a, "maxChars", 4000)
	type page struct {
		URL   string `json:"url"`
		Title string `json:"title,omitempty"`
		Text  string `json:"text,omitempty"`
		Error string `json:"error,omitempty"`
	}
	pages := make([]page, len(urls))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < min(concurrency, len(urls)); worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				func() {
					pages[i] = page{URL: normalizeURL(urls[i])}
					nav, err := s.call("navigate", map[string]any{"url": pages[i].URL, "newTab": true, "background": true})
					if err != nil {
						pages[i].Error = err.Error()
						return
					}
					tabID := nav["tabId"]
					defer func() { _, _ = s.call("close_tab", map[string]any{"tabId": tabID}) }()
					res, err := s.call("reading_mode", map[string]any{"tabId": tabID, "maxChars": maxChars})
					if err != nil {
						pages[i].Error = err.Error()
						return
					}
					pages[i].Title, pages[i].Text = str(res["title"]), str(res["text"])
				}()
			}
		}()
	}
	for i := range urls {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	var b strings.Builder
	for _, pg := range pages {
		fmt.Fprintf(&b, "## %s\n", pg.URL)
		if pg.Error != "" {
			b.WriteString("error: " + pg.Error + "\n\n")
			continue
		}
		fmt.Fprintf(&b, "# %s\n%s\n\n", pg.Title, pg.Text)
	}
	for _, pg := range pages {
		if pg.Error == "" {
			return output{data: map[string]any{"pages": pages}, text: b.String()}, nil
		}
	}
	return output{}, &cmdError{Message: "All crawl URLs failed", Result: pages}
}

func (s *session) ensureReady() error {
	status, err := s.statusMap()
	if err != nil {
		return s.recover(err)
	}
	if status["extensionConnected"] != true {
		return s.waitForExtension()
	}
	return nil
}

func cmdCapture(s *session, a cmdArgs) (output, error) {
	sub := ""
	if len(a.pos) > 0 {
		sub = normalizeCommandName(a.pos[0])
	}
	switch sub {
	case "start":
		res, err := s.call("start_capture", passthrough(a))
		if err != nil {
			return output{}, err
		}
		return generic(res), nil
	case "stop":
		res, err := s.call("stop_capture", passthrough(a))
		if err != nil {
			return output{}, err
		}
		path, err := extractBinary(res, artifactDir(), "capture", posOrFlag(a, 1, "out"))
		if err != nil {
			return output{}, err
		}
		if path == "" {
			path = str(res["dataPath"])
		}
		if destination := posOrFlag(a, 1, "out"); destination != "" && path != "" && path != destination {
			if !s.isLocalBridge() {
				return output{}, &cmdError{Message: "Capture is saved on the remote bridge; copying --out requires a local bridge", Result: res}
			}
			if err := extbridge.CopyFileAtomic(path, destination); err != nil {
				return output{}, err
			}
			path, _ = filepath.Abs(destination)
			res["dataPath"] = path
		}
		if path == "" {
			return output{}, &cmdError{Message: "Capture stopped but no artifact path was returned", Result: res}
		}
		return output{data: res, text: fmt.Sprintf("saved %s (%s, %vms)", path, kb(res["bytes"]), num(res["durationMs"]))}, nil
	}
	return output{}, usagef("usage: browsercontrol capture start | capture stop [out.webm]")
}

func cmdEvidence(s *session, a cmdArgs) (output, error) {
	p := passthrough(a)
	if len(a.pos) > 0 {
		p["mode"] = a.pos[0]
	}
	setDefault(p, "mode", "overview")
	setDefault(p, "sessionId", firstNonEmptyString(s.sessionID, "go-cli"))
	res, err := s.call("evidence", p)
	if err != nil {
		return output{}, err
	}
	return generic(res), nil
}

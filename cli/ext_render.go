package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
)

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

/** Formats JSON numbers without the float64 noise ("123", not "1.23e+02"). */
func num(v any) string {
	if f, ok := v.(float64); ok && f == math.Trunc(f) {
		return fmt.Sprintf("%d", int64(f))
	}
	if v == nil {
		return "?"
	}
	return fmt.Sprint(v)
}

func kb(v any) string {
	f, _ := v.(int)
	if f < 1024 {
		return fmt.Sprintf("%d B", f)
	}
	return fmt.Sprintf("%.1f KB", float64(f)/1024)
}

func truncate(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimRight(s, "\n"), "\n")
}

type filtered struct {
	kept    []string
	dropped int
}

/** Case-insensitive grep plus an optional line cap; both are applied CLI-side so the agent only pays for lines it asked for. */
func filterLines(lines []string, grep string, limit int) filtered {
	var out filtered
	needle := strings.ToLower(grep)
	for _, line := range lines {
		if needle != "" && !strings.Contains(strings.ToLower(line), needle) {
			out.dropped++
			continue
		}
		if limit > 0 && len(out.kept) >= limit {
			out.dropped++
			continue
		}
		out.kept = append(out.kept, line)
	}
	return out
}

/** Default text for results without a dedicated renderer: compact JSON minus the noise keys. */
func generic(res any) output {
	m := asMap(res)
	if m == nil {
		data, _ := json.Marshal(res)
		return output{data: res, text: string(data)}
	}
	view := make(map[string]any, len(m))
	for k, v := range m {
		if k == "success" || k == "telemetry" {
			continue
		}
		view[k] = v
	}
	if len(view) == 1 {
		if msg, ok := view["message"].(string); ok {
			return output{data: res, text: "ok: " + cliHint(msg)}
		}
	}
	data, _ := json.Marshal(view)
	return output{data: res, text: string(data)}
}

func renderAction(res map[string]any) string {
	text := "ok: " + firstNonEmptyString(str(res["message"]), "done")
	if role := str(res["role"]); role != "" {
		text += fmt.Sprintf(" → %s %q", role, str(res["name"]))
	}
	for _, key := range []string{"_riskWarning", "_flowWarning", "warning"} {
		if w := str(res[key]); w != "" {
			text += "\nwarning: " + cliHint(w)
		}
	}
	return text
}

/** One line per node, matching the extension's compact snapshot format: [id] role "name" (v: "value"). */
func formatEntry(m map[string]any) string {
	var b strings.Builder
	if id, ok := m["i"]; ok {
		b.WriteString("[" + num(id) + "] ")
	}
	b.WriteString(firstNonEmptyString(str(m["r"]), "node"))
	if n := str(m["n"]); n != "" {
		fmt.Fprintf(&b, " %q", truncate(n, 160))
	}
	if v := str(m["v"]); v != "" {
		fmt.Fprintf(&b, " (v: %q)", truncate(v, 80))
	}
	return b.String()
}

const maxMergedText = 300

/**
 * Formats snapshot entries, collapsing each run of consecutive StaticText nodes into one line.
 * Pages that wrap every character or word in its own span otherwise cost one line per glyph.
 * A gap in backend node ids means a filtered whitespace/wrapper node sat between two pieces,
 * so that is where a space goes back in.
 */
func formatEntries(nodes []any) []string {
	lines := make([]string, 0, len(nodes))
	for i := 0; i < len(nodes); i++ {
		m := asMap(nodes[i])
		if str(m["r"]) != "StaticText" {
			lines = append(lines, formatEntry(m))
			continue
		}
		var text strings.Builder
		text.WriteString(str(m["n"]))
		prevID, _ := m["i"].(float64)
		j := i + 1
		for ; j < len(nodes); j++ {
			next := asMap(nodes[j])
			if str(next["r"]) != "StaticText" {
				break
			}
			id, _ := next["i"].(float64)
			if id-prevID != 1 {
				text.WriteByte(' ')
			}
			text.WriteString(str(next["n"]))
			prevID = id
		}
		if j == i+1 {
			lines = append(lines, formatEntry(m))
			continue
		}
		lines = append(lines, fmt.Sprintf("[%s] text %q", num(m["i"]), truncate(text.String(), maxMergedText)))
		i = j - 1
	}
	return lines
}

func renderTree(b *strings.Builder, nodes []any, depth int) {
	for _, n := range nodes {
		m := asMap(n)
		b.WriteString(strings.Repeat(" ", min(depth, 8)) + formatEntry(m) + "\n")
		if children, ok := m["children"].([]any); ok {
			renderTree(b, children, depth+1)
		}
	}
}

func formatSemanticNode(m map[string]any) string {
	var b strings.Builder
	b.WriteString(str(m["ref"]) + " " + firstNonEmptyString(str(m["role"]), "node"))
	if n := str(m["name"]); n != "" {
		fmt.Fprintf(&b, " %q", truncate(n, 160))
	}
	if v := str(m["value"]); v != "" {
		fmt.Fprintf(&b, " = %q", truncate(v, 80))
	}
	if m["identityUncertain"] == true {
		b.WriteString(" ?")
	}
	return b.String()
}

/** Semantic nodes indented by parentRef depth; the doc id header is what refs are scoped to. */
func renderSemantic(snap map[string]any, grep string, limit int) string {
	nodes, _ := snap["nodes"].([]any)
	parent := make(map[string]string, len(nodes))
	for _, n := range nodes {
		m := asMap(n)
		parent[str(m["ref"])] = str(m["parentRef"])
	}
	depth := func(ref string) int {
		d := 0
		for p := parent[ref]; p != "" && d < 8; p = parent[p] {
			d++
		}
		return d
	}
	lines := make([]string, 0, len(nodes))
	for i := 0; i < len(nodes); i++ {
		m := asMap(nodes[i])
		line := formatSemanticNode(m)
		// Same text-run collapsing as formatEntries; refs are dense here, so single glyphs join without spaces.
		if str(m["role"]) == "StaticText" {
			pieces := []string{str(m["name"])}
			j := i + 1
			for ; j < len(nodes); j++ {
				next := asMap(nodes[j])
				if str(next["role"]) != "StaticText" || str(next["parentRef"]) != str(m["parentRef"]) {
					break
				}
				pieces = append(pieces, str(next["name"]))
			}
			if j > i+1 {
				line = fmt.Sprintf("%s text %q", str(m["ref"]), truncate(joinPieces(pieces), maxMergedText))
				i = j - 1
			}
		}
		if grep == "" {
			line = strings.Repeat(" ", depth(str(m["ref"]))) + line
		}
		lines = append(lines, line)
	}
	kept := filterLines(lines, grep, limit)
	header := "doc " + str(asMap(snap["scope"])["documentId"])
	if t := str(snap["title"]); t != "" {
		header += " | " + truncate(t, 80)
	}
	if u := str(snap["url"]); u != "" {
		header += " | " + u
	}
	text := header + "\n" + strings.Join(kept.kept, "\n")
	if kept.dropped > 0 {
		text += fmt.Sprintf("\n(%d of %d nodes shown)", len(kept.kept), len(lines))
	}
	if snap["truncated"] == true {
		text += "\n(snapshot truncated by the extension; use 'snapshot --region <css>')"
	}
	return text
}

/** Glues neighbouring single glyphs together and puts a space around anything word-sized. */
func joinPieces(pieces []string) string {
	var b strings.Builder
	for i, p := range pieces {
		if i > 0 && (len([]rune(p)) > 1 || len([]rune(pieces[i-1])) > 1) {
			b.WriteByte(' ')
		}
		b.WriteString(p)
	}
	return b.String()
}

func renderDelta(delta map[string]any, grep string) string {
	var lines []string
	for _, n := range asSlice(delta["added"]) {
		lines = append(lines, "+ "+formatSemanticNode(asMap(n)))
	}
	for _, n := range asSlice(delta["changed"]) {
		lines = append(lines, "~ "+formatSemanticNode(asMap(n)))
	}
	for _, r := range asSlice(delta["removed"]) {
		lines = append(lines, "- "+str(r))
	}
	kept := filterLines(lines, grep, 0).kept
	header := fmt.Sprintf("doc %s diff %s→%s", str(asMap(delta["scope"])["documentId"]), str(delta["fromRevision"]), str(delta["toRevision"]))
	if len(kept) == 0 {
		return header + ": no changes"
	}
	text := header + "\n" + strings.Join(kept, "\n")
	if delta["truncated"] == true {
		text += "\n(diff truncated; run 'snapshot --semantic' for the full state)"
	}
	return text
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func formatFindMatch(m map[string]any) string {
	line := "[" + num(m["i"]) + "] " + strings.ToLower(firstNonEmptyString(str(m["tag"]), "?"))
	if r := str(m["r"]); r != "" && r != "generic" {
		line += " " + r
	}
	name := str(m["n"])
	if name != "" {
		line += fmt.Sprintf(" %q", truncate(name, 100))
	}
	if ctx := str(m["context"]); ctx != "" && ctx != name {
		line += " | " + truncate(ctx, 140)
	}
	return line
}

func formatTab(m map[string]any) string {
	mark := " "
	if m["active"] == true {
		mark = "*"
	}
	line := mark + num(m["tabId"])
	if m["permissions"] == "read_only" {
		line += " [ro]"
	}
	return line + " " + truncate(str(m["title"]), 80) + " | " + truncate(str(m["url"]), 140)
}

func formatRequest(m map[string]any) string {
	status := num(m["status"])
	if m["failed"] == true {
		status = "FAILED(" + str(m["errorText"]) + ")"
	}
	line := fmt.Sprintf("%s %s %s %s", str(m["requestId"]), str(m["method"]), status, strings.ToLower(str(m["resourceType"])))
	if d, ok := m["durationMs"].(float64); ok {
		line += fmt.Sprintf(" %dms", int(d))
	}
	if size, ok := m["sizeBytes"].(float64); ok {
		line += " " + kb(int(size))
	}
	if m["blocked"] == true {
		line += " [mock]"
	}
	return line + " " + truncate(str(m["url"]), 160)
}

var commandHelp = map[string]string{
	"snapshot": `snapshot [--grep txt] [--limit n] [--region css] [--semantic] [--diff]
  default: one line per interactive/text node: [nodeId] role "name" (v: "value")
  --grep     keep lines containing txt (case-insensitive); cheapest way to locate one control
  --region   scope to a container's subtree (indented)
  --semantic document-scoped refs (e12); the doc id is remembered so 'click e12' just works
  --diff     with --semantic: only +added ~changed -removed since the previous semantic snapshot`,
	"click":      "click <target> [--confirm-risky] [--force] [--snap]\n  target: nodeId (12) | ref (e12, needs a prior 'snapshot --semantic') | css (#id, .cls, a[href]) | visible text\n  hovers first, clicks the visible part of the element, refuses if something (cookie banner, modal) covers it; --force clicks anyway\n  risky targets (delete/pay/submit...) are blocked until you confirm with the user and pass --confirm-risky",
	"type":       "type <target> <text...> [--clear] [--confirm-risky] [--snap]\n  text is everything after the target; use --text for text starting with --\n  --clear (or 'fill') replaces the current value instead of appending",
	"fill":       "fill <target> <text...>   = type --clear: replace the field's value (empty text just clears it)",
	"scroll":     "scroll [dy] | [dx dy] | up | down [--in <target>]\n  wheel at the viewport centre, or inside a scroll container (chat log, sidebar, list) with --in; reports page y/max",
	"press":      "press <key> [target]   Enter, Tab, Escape, F5, any character, combos: Control+a, Shift+Tab, Meta+Enter",
	"open":       "open <url> [--new-tab] [--background]   scheme optional (example.com → https://example.com)",
	"wait":       "wait <text|css|xpath> [--gone] [--timeout 15s]   polls every 250ms without side effects\nwait 2s                                           plain sleep",
	"do":         "do <step> <step> ...   each step is one quoted command line, e.g.\n  do \"open example.com\" \"click 'More information'\" \"wait 'IANA'\" read\n  do - < steps.txt      one command per line, '#' comments allowed\n  --snap on 'do' takes one snapshot after the last step; stops at the first failing step",
	"read":       "read [--max-chars 12000]   article/body text of the page",
	"find":       "find <text|css|xpath> [--limit 10]   [nodeId] tag role \"name\" | context",
	"select":     "select <css|nodeId> [--max-chars 8000] [--max-matches n]   markdown of matched elements",
	"screenshot": "screenshot [file] [--full | --target <id|e-ref|css|text> [--padding 8] | --clip x,y,w,h] [--zoom n] [--format jpeg|png|webp] [--quality 1-100]\n  default: viewport | --full: whole page, or the app's inner scroll container stitched (chat/mail/doc UIs)\n  --target: one element, scrolled into view | --clip: rectangle in viewport CSS px (same space as visual boxes)\n  images are CSS-pixel sized on any display (no 2x retina bloat); element/clip captures auto-zoom small areas (max 3x)\n  a background tab is activated for the capture, then the user's previous tab is restored; prints path + real pixel size",
	"visual":     "visual [file] [--grep txt]   annotated screenshot (numbered boxes = nodeIds) + node list",
	"peek":       "peek [--out shot.jpg] [--max-chars 4000]   what the user is looking at (any tab, read-only outside the AI workspace)",
	"tabs":       "tabs [list [--all]] | switch <tabId> | close <tabId> | new <url>\n  '*' = tab commands target by default, [ro] = outside the AI workspace group\n  any command: --tab <tabId> to target a specific tab",
	"net":        "net list [filter] [--limit 30] [--resource-types '[\"xhr\",\"fetch\"]']\nnet detail <requestId> [--body]\nnet clear\nnet har [--out file.har] [--filter s] [--include-bodies]",
	"dev":        "dev layout [nodeId|e-ref|css] | memory [overview|dom|listeners|gc] | process [overview|long_tasks|rendering]\n    emulate [device] [--network slow3g] [--cpu-slowdown 4] | sandbox [on|off] | har",
	"flow":       "flow run|explore <file.json|saved-id> [--return-snapshot] [--domain d]\nflow record [domain] | flow stop [--save id] | flow status | flow list | flow show <id> | flow rm <id>",
	"exec":       "exec <extension_cmd> [key=value ...|--key value|@payload.json|{json}]   raw escape hatch; *Base64 fields are saved to files",
	"status":     "status [--wait 20s]   exit 0 only when the extension is connected; starts the bridge if needed",
	"eval":       "eval <js-expression|@file.js>   returns the value (strings raw, everything else JSON)",
	"crawl":      "crawl <url...|@urls.txt> [--concurrency 3] [--max-chars 4000]   reads each URL in a background tab",
	"search":     "search <query> [--limit 8]   DuckDuckGo results without touching the current tab",
}

func printCommandHelp(name string) {
	if help, ok := commandHelp[name]; ok {
		fmt.Println(help)
		return
	}
	printUsage()
}

/** Reads pixel dimensions from a PNG/JPEG/WebP header, so the agent knows the real image size without opening it. */
func imageSize(data []byte) (int, int, bool) {
	switch {
	case len(data) >= 24 && string(data[1:4]) == "PNG":
		return int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24])), true
	case len(data) >= 30 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		switch string(data[12:16]) {
		case "VP8 ":
			return int(binary.LittleEndian.Uint16(data[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(data[28:30]) & 0x3fff), true
		case "VP8X":
			w := int(data[24]) | int(data[25])<<8 | int(data[26])<<16
			h := int(data[27]) | int(data[28])<<8 | int(data[29])<<16
			return w + 1, h + 1, true
		}
	case len(data) > 4 && data[0] == 0xFF && data[1] == 0xD8:
		for i := 2; i+9 < len(data); {
			if data[i] != 0xFF {
				i++
				continue
			}
			marker := data[i+1]
			if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
				return int(binary.BigEndian.Uint16(data[i+7 : i+9])), int(binary.BigEndian.Uint16(data[i+5 : i+7])), true
			}
			i += 2 + int(binary.BigEndian.Uint16(data[i+2:i+4]))
		}
	}
	return 0, 0, false
}

func imageInfo(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "?"
	}
	if w, h, ok := imageSize(data); ok {
		return fmt.Sprintf("%dx%d px", w, h)
	}
	return "? px"
}

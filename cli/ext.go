package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
)

/** Global flags recognised anywhere on the command line; everything else becomes a command payload flag. */
type globalOpts struct {
	cfg         extbridge.Config
	asJSON      bool
	help        bool
	noAutostart bool
	timeoutSet  bool
	waitSet     bool
	snap        string
	tabID       any
	wait        time.Duration
}

type cmdArgs struct {
	pos   []string
	flags map[string]any
}

// output is what a command produces: data for --json, text for the default agent-facing mode.
type output struct {
	data any
	text string
}

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error { return &usageError{fmt.Sprintf(format, args...)} }

/** An error the extension reported inside a successful bridge reply ({error, hint}). */
type cmdError struct {
	Message string `json:"error"`
	Hint    string `json:"hint,omitempty"`
}

func (e *cmdError) Error() string { return e.Message }

var boolFlags = map[string]bool{
	"full": true, "fullPage": true, "newTab": true, "background": true, "semantic": true, "compact": true,
	"diff": true, "includeBody": true, "body": true, "includeBodies": true, "returnSnapshot": true,
	"confirmRisky": true, "screenshot": true, "includeSelection": true, "touch": true, "all": true,
	"gone": true, "explore": true, "force": true, "clear": true,
}

// Keys whose values are free text and must never be JSON-decoded ("123" stays a string).
var stringFlags = map[string]bool{
	"text": true, "query": true, "selector": true, "url": true, "key": true, "expression": true,
	"filter": true, "documentId": true, "ref": true, "requestId": true, "domain": true, "out": true,
	"grep": true, "region": true, "save": true, "target": true, "clip": true, "in": true,
}

func parseCLI(argv []string, g globalOpts) (globalOpts, cmdArgs, error) {
	a := cmdArgs{flags: map[string]any{}}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			a.pos = append(a.pos, argv[i+1:]...)
			break
		}
		if arg == "-h" {
			g.help = true
			continue
		}
		if !strings.HasPrefix(arg, "--") || len(arg) == 2 {
			a.pos = append(a.pos, arg)
			continue
		}
		name, inline, hasInline := strings.Cut(arg[2:], "=")
		next := func() (string, bool) {
			if hasInline {
				return inline, true
			}
			if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
				i++
				return argv[i], true
			}
			return "", false
		}
		need := func() (string, error) {
			v, ok := next()
			if !ok {
				return "", usagef("--%s needs a value", name)
			}
			return v, nil
		}
		var err error
		var v string
		switch name {
		case "json":
			g.asJSON = !hasInline || inline != "false"
		case "help":
			g.help = true
		case "no-autostart":
			g.noAutostart = true
		case "snap":
			g.snap = "compact"
			if hasInline {
				g.snap = inline
			}
		case "host":
			g.cfg.Host, err = need()
		case "url":
			g.cfg.BaseURL, err = need()
		case "token":
			g.cfg.Token, err = need()
		case "token-file":
			g.cfg.TokenFile, err = need()
		case "port":
			if v, err = need(); err == nil {
				g.cfg.Port, err = strconv.Atoi(v)
			}
		case "timeout":
			if v, err = need(); err == nil {
				g.cfg.Timeout, err = parseDuration(v)
				g.timeoutSet = true
			}
		case "wait":
			if v, err = need(); err == nil {
				g.wait, err = parseDuration(v)
				g.waitSet = true
			}
		case "tab", "tab-id":
			if v, err = need(); err == nil {
				g.tabID, err = parseNumber(v)
			}
		default:
			key := extbridge.NormalizePayloadKey(name)
			if boolFlags[key] {
				a.flags[key] = !hasInline || (inline != "false" && inline != "0")
				continue
			}
			raw, ok := next()
			if !ok {
				a.flags[key] = true
				continue
			}
			if stringFlags[key] {
				a.flags[key] = raw
				continue
			}
			value, perr := extbridge.ParseValue(raw)
			if perr != nil {
				return g, a, perr
			}
			a.flags[key] = value
		}
		if err != nil {
			return g, a, usagef("--%s: %v", name, err)
		}
	}
	return g, a, nil
}

/** Accepts Go durations ("15s") or bare milliseconds ("15000"). */
func parseDuration(v string) (time.Duration, error) {
	if ms, err := strconv.Atoi(v); err == nil {
		return time.Duration(ms) * time.Millisecond, nil
	}
	return time.ParseDuration(v)
}

func parseNumber(v string) (float64, error) {
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil {
		return 0, fmt.Errorf("%q is not a number", v)
	}
	return n, nil
}

func runExtension(argv []string) int {
	g, a, err := parseCLI(argv, globalOpts{})
	if err != nil {
		return reportError(g, err)
	}
	if g.wait == 0 {
		g.wait = 20 * time.Second
	}
	if len(a.pos) == 0 {
		printUsage()
		return 0
	}
	name := canonical(a.pos[0])
	a.pos = a.pos[1:]
	if name == "help" {
		if len(a.pos) > 0 {
			printCommandHelp(canonical(a.pos[0]))
		} else {
			printUsage()
		}
		return 0
	}
	if g.help {
		printCommandHelp(name)
		return 0
	}
	s := newSession(g)
	out, err := s.run(name, a)
	if err != nil {
		return reportError(g, err)
	}
	s.print(out)
	return 0
}

func canonical(name string) string {
	name = strings.ToLower(strings.ReplaceAll(name, "-", "_"))
	if alias, ok := aliases[name]; ok {
		return alias
	}
	return name
}

var aliases = map[string]string{
	"snap": "snapshot", "shot": "screenshot", "nav": "open", "navigate": "open", "goto": "open",
	"text": "read", "reading_mode": "read", "reading": "read", "select_content": "select",
	"inspect_element": "inspect", "peek_screen": "peek", "visual_snapshot": "visual",
	"key": "press", "press_key": "press", "evaluate": "eval", "js": "eval", "tab": "tabs",
	"network": "net", "flows": "flow", "web_search": "search", "batch_crawl": "crawl",
	"batch": "do", "run": "do", "execute": "exec", "call": "exec", "raw": "exec",
	"server": "serve", "bridge": "serve", "auth_token": "token",
	"query_region": "region", "list_tabs": "tabs",
}

type handler func(s *session, a cmdArgs) (output, error)

// commands is populated in init() because several handlers (do, snapshot-after-action) call back into it.
var commands map[string]handler

func init() {
	commands = map[string]handler{
		"status": cmdStatus, "serve": cmdServe, "token": cmdToken, "exec": cmdExec,
		"open": cmdOpen, "back": cmdHistory("history.back()"), "forward": cmdHistory("history.forward()"),
		"reload":   cmdHistory("location.reload()"),
		"snapshot": cmdSnapshot, "region": cmdRegion, "find": cmdFind, "read": cmdRead, "select": cmdSelect,
		"peek": cmdPeek, "inspect": cmdInspect, "screenshot": cmdScreenshot, "visual": cmdVisual,
		"click": cmdClick, "type": cmdType, "fill": cmdFill, "press": cmdPress, "scroll": cmdScroll, "drag": cmdDrag,
		"eval": cmdEval, "wait": cmdWait,
		"tabs": cmdTabs, "net": cmdNet, "dev": cmdDev, "flow": cmdFlow, "search": cmdSearch, "crawl": cmdCrawl,
		"capture": cmdCapture, "evidence": cmdEvidence, "do": cmdDo,
	}
}

// Actions that change the page, so --snap can follow them with a fresh snapshot.
var mutating = map[string]bool{
	"open": true, "back": true, "forward": true, "reload": true, "click": true, "type": true,
	"press": true, "scroll": true, "fill": true, "drag": true, "eval": true,
}

func (s *session) run(name string, a cmdArgs) (output, error) {
	h, ok := commands[name]
	if !ok {
		return output{}, usagef("unknown command %q; run 'browsercontrol help'", name)
	}
	out, err := h(s, a)
	if err != nil || s.g.snap == "" || !mutating[name] {
		return out, err
	}
	snapArgs := cmdArgs{flags: map[string]any{}}
	if s.g.snap == "diff" || s.g.snap == "semantic" {
		snapArgs.flags["semantic"] = true
		snapArgs.flags["diff"] = s.g.snap == "diff"
	}
	snap, err := cmdSnapshot(s, snapArgs)
	if err != nil {
		return out, err
	}
	return output{
		data: map[string]any{"result": out.data, "snapshot": snap.data},
		text: joinNonEmpty(out.text, snap.text),
	}, nil
}

func (s *session) print(out output) {
	if s.g.asJSON {
		writeCompactJSON(os.Stdout, out.data)
		return
	}
	if out.text != "" {
		fmt.Println(strings.TrimRight(out.text, "\n"))
	}
}

func writeCompactJSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func reportError(g globalOpts, err error) int {
	code := 1
	var ue *usageError
	if errors.As(err, &ue) {
		code = 2
	}
	var ce *cmdError
	if !errors.As(err, &ce) {
		ce = &cmdError{Message: err.Error()}
	}
	if g.asJSON {
		writeCompactJSON(os.Stdout, ce)
		return code
	}
	fmt.Fprintf(os.Stderr, "error: %s\n", ce.Message)
	if ce.Hint != "" {
		fmt.Fprintf(os.Stderr, "hint: %s\n", ce.Hint)
	}
	return code
}

func cmdDo(s *session, a cmdArgs) (output, error) {
	steps := a.pos
	if len(steps) == 1 && steps[0] == "-" {
		steps = nil
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			if line := strings.TrimSpace(scanner.Text()); line != "" && !strings.HasPrefix(line, "#") {
				steps = append(steps, line)
			}
		}
		if err := scanner.Err(); err != nil {
			return output{}, err
		}
	}
	if len(steps) == 0 {
		return output{}, usagef(`usage: browsercontrol do "click 12" "type 14 hello" snapshot   (or: do - < steps.txt)`)
	}
	var texts []string
	var results []map[string]any
	// A batch-level --snap means one snapshot at the end, not one after every step.
	base := s.g
	base.snap = ""
	switch s.g.snap {
	case "":
	case "diff":
		steps = append(steps, "snapshot --semantic --diff")
	case "semantic":
		steps = append(steps, "snapshot --semantic")
	default:
		steps = append(steps, "snapshot")
	}
	for i, line := range steps {
		words, err := splitCommandLine(line)
		if err != nil {
			return output{}, usagef("step %d: %v", i+1, err)
		}
		if len(words) == 0 {
			continue
		}
		g, stepArgs, err := parseCLI(words[1:], base)
		if err != nil {
			return output{}, usagef("step %d: %v", i+1, err)
		}
		step := &session{g: g, client: s.client, state: s.state}
		name := canonical(words[0])
		if name == "do" {
			return output{}, usagef("step %d: do cannot be nested", i+1)
		}
		out, err := step.run(name, stepArgs)
		s.client = step.client
		if err != nil {
			var ce *cmdError
			if !errors.As(err, &ce) {
				ce = &cmdError{Message: err.Error()}
			}
			// Keep what already ran visible so the agent knows where the batch stopped.
			if s.g.asJSON {
				writeCompactJSON(os.Stdout, map[string]any{"steps": results})
			} else if len(texts) > 0 {
				fmt.Println(strings.Join(texts, "\n"))
			}
			return output{}, &cmdError{Message: fmt.Sprintf("step %d (%s) failed: %s", i+1, line, ce.Message), Hint: ce.Hint}
		}
		results = append(results, map[string]any{"step": line, "result": out.data})
		texts = append(texts, "> "+line)
		if out.text != "" {
			texts = append(texts, strings.TrimRight(out.text, "\n"))
		}
	}
	return output{data: map[string]any{"steps": results}, text: strings.Join(texts, "\n")}, nil
}

/** Splits one batch step into words with POSIX-ish quoting: '...' literal, "..." with \" escapes. */
func splitCommandLine(line string) ([]string, error) {
	var words []string
	var cur strings.Builder
	inWord := false
	var quote rune
	for i := 0; i < len(line); i++ {
		c := rune(line[i])
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else if c == '\\' && quote == '"' && i+1 < len(line) && (line[i+1] == '"' || line[i+1] == '\\') {
				i++
				cur.WriteByte(line[i])
			} else {
				cur.WriteRune(c)
			}
		case c == '\'' || c == '"':
			quote = c
			inWord = true
		case c == ' ' || c == '\t':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(c)
			inWord = true
		}
	}
	if quote != 0 {
		return nil, fmt.Errorf("unterminated %c quote", quote)
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}

func joinNonEmpty(parts ...string) string {
	var kept []string
	for _, p := range parts {
		if p = strings.TrimRight(p, "\n"); p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "\n")
}

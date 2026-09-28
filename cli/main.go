package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/go-rod/rod"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
)

type options struct {
	tabTarget string
	asJSON    bool
	compact   bool
	fullPage  bool
	newTab    bool
	headless  bool
	port      int
	maxChars  int
	limit     int
	filter    string
	device    string
	out       string
}

func printUsage() {
	fmt.Print(`BrowserControl CLI - headless/serverless Chrome controller for AI agents

Usage:
  browsercontrol <command> [flags] [arguments]

Core commands (CDP direct, no daemon/MCP/server):
  open|navigate <url>        Navigate the active tab, or --new-tab to create one
  snapshot                   Capture compact interactive/semantic elements
  click <target>             Click by snapshot ID, CSS selector, or visible text
  type <target> <text>       Type into an input by snapshot ID/selector/text
  press <key>                Press Enter, Tab, Escape, Backspace, ArrowDown...
  scroll [dx] [dy]           Scroll viewport pixels; default dy=400
  drag <fromX> <fromY> <toX> <toY>
  screenshot [file]          Save viewport/full-page screenshot
  read                       Extract readable text from current page
  find <query>               Search visible text and return snippets
  select <selector>          Extract text from matching DOM nodes
  inspect <target>           Inspect element metadata/layout by target
  eval <js-code>             Evaluate JavaScript in page context
  tabs <subcommand>          list | switch | close | new
  status                     Show Chrome/CDP status

Domain commands:
  page <action>              open | snapshot | read | find | select | inspect | eval | screenshot
  input <action>             click | type | press | scroll | drag
  net <action>               list | har | clear
  dev <action>               layout | memory | process | emulate | sandbox
  flow <action>              run | list | save | get | delete

Examples:
  browsercontrol open https://example.com --headless
  browsercontrol snapshot --json
  browsercontrol click 1
  browsercontrol type '#q' 'golang cdp cli'
  browsercontrol net list --json --limit 30
  browsercontrol dev layout '#app' --json
  browsercontrol flow run ./flow.json --json
  browsercontrol flow save login ./login-flow.json

Flags:
  --tab <id|index>           Target a tab by target ID/prefix or 1-based index
  --new-tab                  Open URL in a new tab
  --json                     Print machine-readable JSON
  --compact                  Compact snapshot output
  --headless                 Launch Chrome with --headless=new when not running
  --full                     Full page screenshot
  --port <number>            Chrome CDP port (default: 9222)
  --max-chars <number>       Reading/select output cap (default: 20000)
  --limit <number>           Result limit for find/network/select (default: 20)
  --filter <text>            Filter network/HAR entries
  --device <name>            Device preset for dev emulate
  --out <file>               Output path for commands that save files
`)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		return
	}

	cmd := os.Args[1]
	args := os.Args[2:]
	opt := parseFlags(cmd, args)
	remainingArgs := opt.args

	if cmd == "help" || cmd == "-h" || cmd == "--help" {
		printUsage()
		return
	}

	cfg := browser.DefaultConfig()
	cfg.Port = opt.port
	cfg.Headless = opt.headless

	if cmd == "status" {
		handleStatus(cfg, opt)
		return
	}

	b, err := browser.GetBrowser(cfg)
	if err != nil {
		fatal(opt.asJSON, "failed to initialize Chrome: %v", err)
	}

	switch cmd {
	case "page":
		handlePage(b, remainingArgs, opt)
	case "input":
		handleInput(b, remainingArgs, opt)
	case "net", "network":
		handleNetwork(b, remainingArgs, opt)
	case "dev":
		handleDev(b, remainingArgs, opt)
	case "flow", "flows":
		handleFlow(b, remainingArgs, opt)
	case "tabs", "tab":
		handleTabs(b, remainingArgs, opt)

	case "open", "navigate", "nav":
		handlePage(b, append([]string{"open"}, remainingArgs...), opt)
	case "snapshot", "snap":
		handlePage(b, append([]string{"snapshot"}, remainingArgs...), opt)
	case "read", "reading-mode", "text":
		handlePage(b, append([]string{"read"}, remainingArgs...), opt)
	case "find":
		handlePage(b, append([]string{"find"}, remainingArgs...), opt)
	case "select", "select-content":
		handlePage(b, append([]string{"select"}, remainingArgs...), opt)
	case "inspect", "inspect-element":
		handlePage(b, append([]string{"inspect"}, remainingArgs...), opt)
	case "eval", "evaluate":
		handlePage(b, append([]string{"eval"}, remainingArgs...), opt)
	case "screenshot", "shot":
		handlePage(b, append([]string{"screenshot"}, remainingArgs...), opt)

	case "click", "type", "press", "key", "scroll", "drag":
		handleInput(b, append([]string{cmd}, remainingArgs...), opt)
	default:
		fatal(opt.asJSON, "unknown command %q; run 'browsercontrol help'", cmd)
	}
}

type parsedOptions struct {
	options
	args []string
}

func parseFlags(cmd string, args []string) parsedOptions {
	var opt options
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.StringVar(&opt.tabTarget, "tab", "", "target tab ID or index")
	fs.BoolVar(&opt.asJSON, "json", false, "print JSON")
	fs.BoolVar(&opt.compact, "compact", false, "compact text output")
	fs.BoolVar(&opt.fullPage, "full", false, "full page screenshot")
	fs.BoolVar(&opt.newTab, "new-tab", false, "open in a new tab")
	fs.BoolVar(&opt.headless, "headless", false, "launch Chrome headless")
	fs.IntVar(&opt.port, "port", browser.DefaultCDPPort, "Chrome CDP port")
	fs.IntVar(&opt.maxChars, "max-chars", 20000, "max chars")
	fs.IntVar(&opt.limit, "limit", 20, "result limit")
	fs.StringVar(&opt.filter, "filter", "", "filter string")
	fs.StringVar(&opt.device, "device", "", "device preset")
	fs.StringVar(&opt.out, "out", "", "output path")

	if err := fs.Parse(reorderFlagArgs(args)); err != nil {
		os.Exit(1)
	}
	return parsedOptions{options: opt, args: fs.Args()}
}

func handleStatus(cfg browser.Config, opt parsedOptions) {
	available := browser.IsCDPAvailable(cfg.Port)
	status := map[string]any{"cdpPort": cfg.Port, "cdpAvailable": available, "headlessRequested": cfg.Headless}
	if !available {
		if opt.asJSON {
			outputJSON(status)
			return
		}
		fmt.Printf("Chrome CDP is not active on port %d. Running a command will launch Chrome directly.\n", cfg.Port)
		return
	}
	b, err := browser.GetBrowser(cfg)
	if err != nil {
		fatal(opt.asJSON, "error connecting to Chrome: %v", err)
	}
	tabs, _ := browser.ListTabs(b)
	status["tabs"] = tabs
	if opt.asJSON {
		outputJSON(status)
		return
	}
	fmt.Printf("Chrome CDP is active on port %d (%d open tabs).\n", cfg.Port, len(tabs))
	for _, t := range tabs {
		mark := " "
		if t.Active {
			mark = "*"
		}
		fmt.Printf(" [%d]%s %s - %s\n", t.Index, mark, t.Title, t.URL)
	}
}

func handlePage(b *rod.Browser, args []string, opt parsedOptions) {
	if len(args) == 0 {
		fatal(opt.asJSON, "usage: browsercontrol page <open|snapshot|read|find|select|inspect|eval|screenshot> ...")
	}
	action := args[0]
	rest := args[1:]

	switch action {
	case "open", "navigate", "nav":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol page open <url>")
		}
		if opt.newTab {
			_, tab, err := browser.NewTab(b, rest[0])
			check(opt.asJSON, err)
			outputSuccess(opt.asJSON, fmt.Sprintf("opened new tab [%d] at %s", tab.Index, rest[0]), tab)
			return
		}
		p := mustPage(b, opt)
		res, err := browser.Navigate(p, rest[0])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "snapshot", "snap":
		p := mustPage(b, opt)
		nodes, err := browser.TakeSnapshot(p)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(nodes)
			return
		}
		fmt.Print(browser.FormatSnapshotCompact(nodes))
	case "read", "reading-mode", "text":
		p := mustPage(b, opt)
		res, err := browser.ExtractReadingMode(p, opt.maxChars)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(res)
			return
		}
		fmt.Printf("=== %s ===\nURL: %s\n(%d chars)\n\n%s\n", res.Title, res.URL, res.Chars, res.Text)
	case "find":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol page find <query>")
		}
		p := mustPage(b, opt)
		res, err := browser.Find(p, strings.Join(rest, " "), opt.limit)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(res)
			return
		}
		for _, m := range res.Matches {
			fmt.Printf("[%d] %s\n", m.Index, m.Text)
		}
	case "select", "select-content":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol page select <css-selector>")
		}
		p := mustPage(b, opt)
		res, err := browser.SelectContent(p, rest[0], opt.maxChars, opt.limit)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(res)
			return
		}
		for _, item := range res.Items {
			fmt.Printf("[%d] %s\n", item.Index, item.Text)
		}
	case "inspect", "inspect-element":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol page inspect <target>")
		}
		p := mustPage(b, opt)
		res, err := browser.InspectElement(p, rest[0])
		check(opt.asJSON, err)
		outputJSON(res)
	case "eval", "evaluate":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol page eval <javascript>")
		}
		p := mustPage(b, opt)
		res, err := browser.Eval(p, strings.Join(rest, " "))
		check(opt.asJSON, err)
		outputJSON(res)
	case "screenshot", "shot":
		p := mustPage(b, opt)
		outputPath := opt.out
		if outputPath == "" && len(rest) > 0 {
			outputPath = rest[0]
		}
		path, err := browser.Screenshot(p, outputPath, opt.fullPage)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, "screenshot saved", map[string]string{"path": path})
	default:
		fatal(opt.asJSON, "unknown page action %q", action)
	}
}

func handleInput(b *rod.Browser, args []string, opt parsedOptions) {
	if len(args) == 0 {
		fatal(opt.asJSON, "usage: browsercontrol input <click|type|press|scroll|drag> ...")
	}
	action := args[0]
	rest := args[1:]
	p := mustPage(b, opt)

	switch action {
	case "click":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol input click <target>")
		}
		res, err := browser.Click(p, rest[0])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "type":
		if len(rest) < 2 {
			fatal(opt.asJSON, "usage: browsercontrol input type <target> <text>")
		}
		res, err := browser.Type(p, rest[0], rest[1], false)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "press", "key":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol input press <key>")
		}
		res, err := browser.PressKey(p, rest[0])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "scroll":
		dx, dy := parseDeltas(rest)
		res, err := browser.Scroll(p, dx, dy)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "drag":
		if len(rest) < 4 {
			fatal(opt.asJSON, "usage: browsercontrol input drag <fromX> <fromY> <toX> <toY>")
		}
		vals := make([]float64, 4)
		for i := range vals {
			v, err := strconv.ParseFloat(rest[i], 64)
			check(opt.asJSON, err)
			vals[i] = v
		}
		res, err := browser.Drag(p, vals[0], vals[1], vals[2], vals[3])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	default:
		fatal(opt.asJSON, "unknown input action %q", action)
	}
}

func handleTabs(b *rod.Browser, args []string, opt parsedOptions) {
	subcmd := "list"
	if len(args) > 0 {
		subcmd = args[0]
	}
	switch subcmd {
	case "list", "ls":
		tabs, err := browser.ListTabs(b)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(tabs)
			return
		}
		for _, t := range tabs {
			mark := " "
			if t.Active {
				mark = "*"
			}
			fmt.Printf("[%d]%s %s | %s | %s\n", t.Index, mark, t.ID, t.Title, t.URL)
		}
	case "switch":
		if len(args) < 2 {
			fatal(opt.asJSON, "usage: browsercontrol tabs switch <tab-id-or-index>")
		}
		tab, err := browser.SwitchTab(b, args[1])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, "tab switched", tab)
	case "close":
		if len(args) < 2 {
			fatal(opt.asJSON, "usage: browsercontrol tabs close <tab-id-or-index>")
		}
		err := browser.CloseTab(b, args[1])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, "tab closed", map[string]string{"target": args[1]})
	case "new":
		url := ""
		if len(args) > 1 {
			url = args[1]
		}
		_, tab, err := browser.NewTab(b, url)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, "tab created", tab)
	default:
		fatal(opt.asJSON, "unknown tabs subcommand %q", subcmd)
	}
}

func handleNetwork(b *rod.Browser, args []string, opt parsedOptions) {
	action := "list"
	if len(args) > 0 {
		action = args[0]
	}
	p := mustPage(b, opt)
	switch action {
	case "list", "requests":
		res, err := browser.NetworkEntries(p, opt.filter, opt.limit)
		check(opt.asJSON, err)
		outputJSON(res)
	case "har", "export-har":
		res, err := browser.HAR(p, opt.filter, opt.limit)
		check(opt.asJSON, err)
		if opt.out != "" {
			check(opt.asJSON, browser.WriteJSONFile(opt.out, res))
			outputSuccess(opt.asJSON, "HAR written", map[string]string{"path": opt.out})
			return
		}
		outputJSON(res)
	case "clear":
		res, err := browser.ClearPerformanceEntries(p)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	default:
		fatal(opt.asJSON, "unknown net action %q", action)
	}
}

func handleDev(b *rod.Browser, args []string, opt parsedOptions) {
	if len(args) == 0 {
		fatal(opt.asJSON, "usage: browsercontrol dev <layout|memory|process|emulate|sandbox> ...")
	}
	action := args[0]
	rest := args[1:]
	p := mustPage(b, opt)
	switch action {
	case "layout", "debug-layout":
		target := "body"
		if len(rest) > 0 {
			target = rest[0]
		}
		res, err := browser.Layout(p, target)
		check(opt.asJSON, err)
		outputJSON(res)
	case "memory", "inspect-memory":
		res, err := browser.Memory(p)
		check(opt.asJSON, err)
		outputJSON(res)
	case "process", "inspect-process":
		res, err := browser.Process(p)
		check(opt.asJSON, err)
		outputJSON(res)
	case "emulate":
		device := opt.device
		if device == "" && len(rest) > 0 {
			device = rest[0]
		}
		res, err := browser.Emulate(p, device)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	case "sandbox":
		mode := "block_mutations"
		if len(rest) > 0 {
			mode = rest[0]
		}
		res, err := browser.Sandbox(p, mode)
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, res.Message, res)
	default:
		fatal(opt.asJSON, "unknown dev action %q", action)
	}
}

func handleFlow(b *rod.Browser, args []string, opt parsedOptions) {
	if len(args) == 0 {
		fatal(opt.asJSON, "usage: browsercontrol flow <run|list|save|get|delete> ...")
	}
	action := args[0]
	rest := args[1:]
	switch action {
	case "run":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol flow run <flow-id|flow.json>")
		}
		steps, err := browser.LoadFlow(rest[0])
		check(opt.asJSON, err)
		p := mustPage(b, opt)
		report, err := browser.RunFlow(p, steps)
		if err != nil {
			if opt.asJSON {
				outputJSON(report)
			} else {
				fmt.Printf("Flow FAILED (%d/%d steps passed): %v\n", report.PassedSteps, report.TotalSteps, err)
			}
			os.Exit(1)
		}
		if opt.asJSON {
			outputJSON(report)
			return
		}
		fmt.Printf("Flow SUCCESS (%d steps passed in %s)\n", report.TotalSteps, report.Duration)
		for _, s := range report.Steps {
			fmt.Printf("  [%d] %s: %s (%s)\n", s.StepIndex, s.Action, s.Message, s.Duration)
		}
	case "list", "ls":
		flows, err := browser.ListSavedFlows()
		check(opt.asJSON, err)
		outputJSON(flows)
	case "save":
		if len(rest) < 2 {
			fatal(opt.asJSON, "usage: browsercontrol flow save <id> <flow.json>")
		}
		flow, err := browser.SaveFlow(rest[0], rest[1])
		check(opt.asJSON, err)
		outputSuccess(opt.asJSON, "flow saved", flow)
	case "get", "show":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol flow get <id>")
		}
		flow, err := browser.GetSavedFlow(rest[0])
		check(opt.asJSON, err)
		outputJSON(flow)
	case "delete", "rm":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol flow delete <id>")
		}
		check(opt.asJSON, browser.DeleteSavedFlow(rest[0]))
		outputSuccess(opt.asJSON, "flow deleted", map[string]string{"id": rest[0]})
	default:
		fatal(opt.asJSON, "unknown flow action %q", action)
	}
}

func mustPage(b *rod.Browser, opt parsedOptions) *rod.Page {
	p, err := browser.ResolvePage(b, opt.tabTarget)
	check(opt.asJSON, err)
	return p
}

func parseDeltas(args []string) (float64, float64) {
	dx, dy := 0.0, 400.0
	if len(args) >= 2 {
		if v, err := strconv.ParseFloat(args[0], 64); err == nil {
			dx = v
		}
		if v, err := strconv.ParseFloat(args[1], 64); err == nil {
			dy = v
		}
	} else if len(args) == 1 {
		if v, err := strconv.ParseFloat(args[0], 64); err == nil {
			dy = v
		}
	}
	return dx, dy
}

func reorderFlagArgs(args []string) []string {
	boolFlags := map[string]bool{"--json": true, "--compact": true, "--full": true, "--new-tab": true, "--headless": true}
	valueFlags := map[string]bool{"--tab": true, "--port": true, "--max-chars": true, "--limit": true, "--filter": true, "--device": true, "--out": true}
	var flags []string
	var positionals []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name := arg
		if before, _, ok := strings.Cut(arg, "="); ok {
			name = before
		}
		if boolFlags[name] || (strings.Contains(arg, "=") && valueFlags[name]) {
			flags = append(flags, arg)
			continue
		}
		if valueFlags[name] {
			flags = append(flags, arg)
			if !strings.Contains(arg, "=") && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		positionals = append(positionals, arg)
	}
	return append(flags, positionals...)
}

func outputJSON(v any) {
	bytes, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(bytes))
}

func outputSuccess(asJSON bool, message string, data any) {
	if asJSON {
		outputJSON(map[string]any{"success": true, "message": message, "data": data})
		return
	}
	fmt.Println(message)
}

func check(asJSON bool, err error) {
	if err != nil {
		fatal(asJSON, "%v", err)
	}
}

func fatal(asJSON bool, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if asJSON {
		outputJSON(map[string]any{"success": false, "error": msg})
	} else {
		fmt.Fprintf(os.Stderr, "Error: %s\n", msg)
	}
	os.Exit(1)
}

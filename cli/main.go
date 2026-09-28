package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
	daemoncli "github.com/hydra07/browsercontrol/cli/internal/daemon"
)

func printUsage() {
	fmt.Print(`BrowserControl CLI - high-speed Chrome controller for AI agents

Usage:
  browsercontrol <command> [flags] [arguments]

Direct CDP commands:
  navigate <url>             Navigate to a URL
  snapshot                   Capture interactive elements on the page
  click <target>             Click an element by snapshot ID, CSS selector, or text
  type <target> <text>       Type text into an input field by ID or selector
  press <key>                Press a keyboard key
  scroll [dx] [dy]           Scroll the page
  screenshot [file]          Take a screenshot
  read                       Extract readable content from the current page
  eval <js-code>             Run JavaScript in page context
  tabs <subcommand>          list | switch | close | new
  flow <file.json>           Run a local direct-CDP automation sequence
  status                     Check direct CDP status

Daemon/API parity commands:
  exec <cmd> [payload] [k=v]  POST /execute for any server BrowserCommand
  daemon <subcommand>         status | metrics | execute | raw
  flows <subcommand>          list | get | save | delete | run
  agent <subcommand>          status | query | stream | abort

Daemon command examples:
  browsercontrol exec snapshot compact=true semantic=true --json
  browsercontrol exec network_requests limit=20 filter=api --json
  browsercontrol exec dev_har includeBodies=true --json
  browsercontrol exec run_flow @flow.json returnSnapshot=true --json
  browsercontrol flows list --json
  browsercontrol flows save @flow.json --json
  browsercontrol agent query "summarize this page" agentId=agy effort=high --json
  browsercontrol daemon raw GET /metrics --json

Payload syntax:
  key=value                  value is parsed as JSON when possible
  @file.json                 merge a JSON object from file into request body
  '{"key":"value"}'          merge inline JSON object into request body

Flags:
  --tab <id|index>           Target a specific direct-CDP tab
  --new-tab                  Open in a new direct-CDP tab
  --compact                  Return compact snapshot format
  --json                     Print JSON output when supported
  --headless                 Launch direct-CDP Chrome headless
  --port <number>            Chrome CDP port (default: 9222)
  --daemon-url <url>         Daemon URL (default: http://127.0.0.1:8765)
  --daemon-port <number>     Daemon port when --daemon-url is not set (default: 8765)
  --token <token>            Daemon bearer token; defaults to BROWSERCONTROL_AUTH_TOKEN or data/daemon-auth-token
  --token-file <path>        Read daemon bearer token from a file
  --timeout <duration>       Daemon request timeout (default: 30s)
`)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(0)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	// Common flags.
	var tabTarget string
	var asJSON bool
	var compact bool
	var fullPage bool
	var newTab bool
	var headless bool
	var port int
	var maxChars int
	var daemonURL string
	var daemonPort int
	var daemonToken string
	var daemonTokenFile string
	var requestTimeout time.Duration

	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.StringVar(&tabTarget, "tab", "", "Target tab ID or index")
	fs.BoolVar(&asJSON, "json", false, "Output result as JSON")
	fs.BoolVar(&compact, "compact", false, "Use compact format for snapshot")
	fs.BoolVar(&fullPage, "full", false, "Full page screenshot")
	fs.BoolVar(&newTab, "new-tab", false, "Open in new tab")
	fs.BoolVar(&headless, "headless", false, "Run Chrome in headless mode")
	fs.IntVar(&port, "port", browser.DefaultCDPPort, "CDP port")
	fs.IntVar(&maxChars, "max-chars", 20000, "Max characters for reading mode")
	fs.StringVar(&daemonURL, "daemon-url", "", "BrowserControl daemon URL")
	fs.IntVar(&daemonPort, "daemon-port", daemoncli.DefaultPort, "BrowserControl daemon port")
	fs.StringVar(&daemonToken, "token", "", "BrowserControl daemon bearer token")
	fs.StringVar(&daemonTokenFile, "token-file", "", "BrowserControl daemon bearer token file")
	fs.DurationVar(&requestTimeout, "timeout", 30*time.Second, "BrowserControl daemon request timeout")

	if err := fs.Parse(reorderFlagArgs(args)); err != nil {
		os.Exit(1)
	}
	remainingArgs := fs.Args()

	daemonCfg := daemoncli.Config{
		BaseURL:   daemonURL,
		Port:      daemonPort,
		Token:     daemonToken,
		TokenFile: daemonTokenFile,
		Timeout:   requestTimeout,
	}

	switch cmd {
	case "help", "-h", "--help":
		printUsage()
		return
	case "daemon", "server":
		if err := daemoncli.HandleDaemon(remainingArgs, daemonCfg, asJSON); err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		return
	case "exec", "execute":
		if err := daemoncli.HandleExecute(remainingArgs, daemonCfg, asJSON); err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		return
	case "flows":
		if err := daemoncli.HandleFlows(remainingArgs, daemonCfg, asJSON); err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		return
	case "agent":
		if err := daemoncli.HandleAgent(remainingArgs, daemonCfg, asJSON); err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		return
	}

	cfg := browser.DefaultConfig()
	cfg.Port = port
	cfg.Headless = headless

	switch cmd {
	case "status":
		available := browser.IsCDPAvailable(port)
		if !available {
			fmt.Printf("Chrome CDP is NOT active on port %d.\nRunning any direct CDP command will automatically launch Chrome with remote debugging.\n", port)
			return
		}
		b, err := browser.GetBrowser(cfg)
		if err != nil {
			fmt.Printf("Error connecting to Chrome: %v\n", err)
			os.Exit(1)
		}
		tabs, _ := browser.ListTabs(b)
		fmt.Printf("Chrome CDP is active on port %d (%d open tabs).\n", port, len(tabs))
		for _, t := range tabs {
			activeMark := " "
			if t.Active {
				activeMark = "*"
			}
			fmt.Printf(" [%d]%s %s - %s\n", t.Index, activeMark, t.Title, t.URL)
		}
		return
	}

	// Connect to Chrome or launch if not yet running for direct CDP commands.
	b, err := browser.GetBrowser(cfg)
	if err != nil {
		outputError(asJSON, fmt.Sprintf("Failed to initialize Chrome: %v", err))
		os.Exit(1)
	}

	switch cmd {
	case "tabs":
		subcmd := "list"
		if len(remainingArgs) > 0 {
			subcmd = remainingArgs[0]
		}
		switch subcmd {
		case "list":
			tabs, err := browser.ListTabs(b)
			if err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			if asJSON {
				outputJSON(tabs)
			} else {
				fmt.Printf("Open Tabs (%d):\n", len(tabs))
				for _, t := range tabs {
					mark := " "
					if t.Active {
						mark = "*"
					}
					fmt.Printf(" [%d]%s ID: %s | %s (%s)\n", t.Index, mark, t.ID, t.Title, t.URL)
				}
			}

		case "switch":
			if len(remainingArgs) < 2 {
				outputError(asJSON, "Usage: browsercontrol tabs switch <tab-id-or-index>")
				os.Exit(1)
			}
			tab, err := browser.SwitchTab(b, remainingArgs[1])
			if err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			outputSuccess(asJSON, fmt.Sprintf("Switched to tab: %s (%s)", tab.Title, tab.URL), tab)

		case "close":
			if len(remainingArgs) < 2 {
				outputError(asJSON, "Usage: browsercontrol tabs close <tab-id-or-index>")
				os.Exit(1)
			}
			if err := browser.CloseTab(b, remainingArgs[1]); err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			outputSuccess(asJSON, fmt.Sprintf("Closed tab %s", remainingArgs[1]), nil)

		case "new":
			url := ""
			if len(remainingArgs) >= 2 {
				url = remainingArgs[1]
			}
			_, tab, err := browser.NewTab(b, url)
			if err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			outputSuccess(asJSON, fmt.Sprintf("Created new tab: %s", tab.ID), tab)

		default:
			outputError(asJSON, fmt.Sprintf("Unknown tabs subcommand %q (supported: list, switch, close, new)", subcmd))
			os.Exit(1)
		}

	case "navigate", "nav", "open":
		if len(remainingArgs) < 1 {
			outputError(asJSON, "Usage: browsercontrol navigate <url>")
			os.Exit(1)
		}
		url := remainingArgs[0]

		if newTab {
			_, t, err := browser.NewTab(b, url)
			if err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			outputSuccess(asJSON, fmt.Sprintf("Opened new tab [%d] at %s", t.Index, url), t)
			return
		}

		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		page, err := browser.Navigate(p, url)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, page.Message, page)

	case "snapshot", "snap":
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		nodes, err := browser.TakeSnapshot(p)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		if asJSON {
			outputJSON(nodes)
		} else if compact {
			fmt.Print(browser.FormatSnapshotCompact(nodes))
		} else {
			fmt.Print(browser.FormatSnapshotCompact(nodes))
		}

	case "click":
		if len(remainingArgs) < 1 {
			outputError(asJSON, "Usage: browsercontrol click <target-id-or-selector>")
			os.Exit(1)
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Click(p, remainingArgs[0])
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, res.Message, res)

	case "type":
		if len(remainingArgs) < 2 {
			outputError(asJSON, "Usage: browsercontrol type <target-id-or-selector> <text>")
			os.Exit(1)
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Type(p, remainingArgs[0], remainingArgs[1], false)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, res.Message, res)

	case "press", "key":
		if len(remainingArgs) < 1 {
			outputError(asJSON, "Usage: browsercontrol press <key-name> (e.g. Enter, Tab, Escape, ArrowDown)")
			os.Exit(1)
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.PressKey(p, remainingArgs[0])
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, res.Message, res)

	case "scroll":
		dx, dy := 0.0, 400.0
		if len(remainingArgs) >= 2 {
			if v, err := strconv.ParseFloat(remainingArgs[0], 64); err == nil {
				dx = v
			}
			if v, err := strconv.ParseFloat(remainingArgs[1], 64); err == nil {
				dy = v
			}
		} else if len(remainingArgs) == 1 {
			if v, err := strconv.ParseFloat(remainingArgs[0], 64); err == nil {
				dy = v
			}
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Scroll(p, dx, dy)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, res.Message, res)

	case "screenshot", "shot":
		outputPath := ""
		if len(remainingArgs) > 0 {
			outputPath = remainingArgs[0]
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		path, err := browser.Screenshot(p, outputPath, fullPage)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputSuccess(asJSON, fmt.Sprintf("Screenshot saved to: %s", path), map[string]string{"path": path})

	case "read", "reading-mode", "text":
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.ExtractReadingMode(p, maxChars)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		if asJSON {
			outputJSON(res)
		} else {
			fmt.Printf("=== %s ===\nURL: %s\n(%d chars)\n\n%s\n", res.Title, res.URL, res.Chars, res.Text)
		}

	case "eval", "evaluate":
		if len(remainingArgs) < 1 {
			outputError(asJSON, "Usage: browsercontrol eval <javascript-expression>")
			os.Exit(1)
		}
		expr := strings.Join(remainingArgs, " ")
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Eval(p, expr)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		outputJSON(res)

	case "flow":
		if len(remainingArgs) < 1 {
			outputError(asJSON, "Usage: browsercontrol flow <steps.json>")
			os.Exit(1)
		}
		steps, err := browser.LoadFlowFile(remainingArgs[0])
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		report, err := browser.RunFlow(p, steps)
		if err != nil {
			if asJSON {
				outputJSON(report)
			} else {
				fmt.Printf("Flow FAILED (%d/%d steps passed): %v\n", report.PassedSteps, report.TotalSteps, err)
			}
			os.Exit(1)
		}
		if asJSON {
			outputJSON(report)
		} else {
			fmt.Printf("Flow SUCCESS (%d steps passed in %s)\n", report.TotalSteps, report.Duration)
			for _, s := range report.Steps {
				fmt.Printf("  [%d] %s: %s (%s)\n", s.StepIndex, s.Action, s.Message, s.Duration)
			}
		}

	default:
		outputError(asJSON, fmt.Sprintf("Unknown command %q. Run 'browsercontrol help' for usage.", cmd))
		os.Exit(1)
	}
}

func reorderFlagArgs(args []string) []string {
	boolFlags := map[string]bool{
		"--json":     true,
		"--compact":  true,
		"--full":     true,
		"--new-tab":  true,
		"--headless": true,
	}
	valueFlags := map[string]bool{
		"--tab":         true,
		"--port":        true,
		"--max-chars":   true,
		"--daemon-url":  true,
		"--daemon-port": true,
		"--token":       true,
		"--token-file":  true,
		"--timeout":     true,
	}
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

func outputJSON(v interface{}) {
	bytes, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(bytes))
}

func outputSuccess(asJSON bool, message string, data interface{}) {
	if asJSON {
		outputJSON(map[string]interface{}{
			"success": true,
			"message": message,
			"data":    data,
		})
	} else {
		fmt.Println(message)
	}
}

func outputError(asJSON bool, message string) {
	if asJSON {
		outputJSON(map[string]interface{}{
			"success": false,
			"error":   message,
		})
	} else {
		fmt.Fprintf(os.Stderr, "Error: %s\n", message)
	}
}

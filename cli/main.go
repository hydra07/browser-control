package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
)

func printUsage() {
	fmt.Println(`BrowserControl CLI - High-speed, serverless Chrome controller for AI Agents

Usage:
  browsercontrol <command> [arguments] [flags]

Commands:
  navigate <url>             Navigate to a URL (e.g. browsercontrol navigate https://google.com)
  snapshot                   Capture interactive elements on page (for buttons, links, inputs)
  click <target>             Click an element by snapshot ID [1..N], CSS selector, or text
  type <target> <text>       Type text into an input field by ID or selector
  press <key>                Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown...)
  scroll [dx] [dy]           Scroll the page (e.g. browsercontrol scroll 0 500)
  screenshot [file]          Take a screenshot (saved to ~/.browsercontrol/screenshots by default)
  read                       Extract clean article text / readable content from current page
  eval <js-code>             Run JavaScript in page context and print the returned value
  tabs                       List, switch, create, or close browser tabs
  flow <file.json>           Run a multi-step automation sequence from a JSON file
  status                     Check connection status and active Chrome instances

Flags:
  --tab <id|index>           Target a specific tab by ID or 1-based index (defaults to active tab)
  --new-tab                  Open in a new tab (used with navigate)
  --compact                  Return compact 1-line format for snapshot (saves tokens)
  --json                     Output result as JSON for programmatic agent parsing
  --headless                 Run Chrome in headless mode
  --port <number>            Chrome CDP port (default: 9222)

Examples:
  browsercontrol navigate https://news.ycombinator.com
  browsercontrol snapshot --compact
  browsercontrol click 1
  browsercontrol type "#search" "golang"
  browsercontrol press Enter
  browsercontrol read
  browsercontrol tabs list
  browsercontrol tabs switch 2
`)
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(0)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	// Common flags
	var tabTarget string
	var asJSON bool
	var compact bool
	var fullPage bool
	var newTab bool
	var headless bool
	var port int
	var maxChars int

	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.StringVar(&tabTarget, "tab", "", "Target tab ID or index")
	fs.BoolVar(&asJSON, "json", false, "Output result as JSON")
	fs.BoolVar(&compact, "compact", false, "Use compact format for snapshot")
	fs.BoolVar(&fullPage, "full", false, "Full page screenshot")
	fs.BoolVar(&newTab, "new-tab", false, "Open in new tab")
	fs.BoolVar(&headless, "headless", false, "Run Chrome in headless mode")
	fs.IntVar(&port, "port", browser.DefaultCDPPort, "CDP port")
	fs.IntVar(&maxChars, "max-chars", 20000, "Max characters for reading mode")

	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}
	remainingArgs := fs.Args()

	cfg := browser.DefaultConfig()
	cfg.Port = port
	cfg.Headless = headless

	switch cmd {
	case "help", "-h", "--help":
		printUsage()
		return

	case "status":
		available := browser.IsCDPAvailable(port)
		if !available {
			fmt.Printf("Chrome CDP is NOT active on port %d.\nRunning any command will automatically launch Chrome with remote debugging.\n", port)
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

	// Connect to Chrome or launch if not yet running
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
		var page *browser.ActionResult
		var navErr error

		if newTab {
			p, t, err := browser.NewTab(b, url)
			if err != nil {
				outputError(asJSON, err.Error())
				os.Exit(1)
			}
			outputSuccess(asJSON, fmt.Sprintf("Opened new tab [%d] at %s", t.Index, url), t)
			_ = p
			return
		}

		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		page, navErr = browser.Navigate(p, url)
		if navErr != nil {
			outputError(asJSON, navErr.Error())
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
		target := remainingArgs[0]
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Click(p, target)
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
		target := remainingArgs[0]
		text := remainingArgs[1]
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.Type(p, target, text, false)
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
		key := remainingArgs[0]
		p, err := browser.ResolvePage(b, tabTarget)
		if err != nil {
			outputError(asJSON, err.Error())
			os.Exit(1)
		}
		res, err := browser.PressKey(p, key)
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

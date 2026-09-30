package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/go-rod/rod"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
)

/** Handles the CDP commands that main's switch doesn't; reports whether cmd was one of them. */
func runCDPExtended(ctx *browserContext, cmd string, args []string) bool {
	if cmd == "page" && len(args) > 0 {
		switch args[0] {
		case "peek", "peek-screen", "visual", "visual-snapshot", "query-region", "query_region", "web-search", "web_search", "search":
			cmd, args = args[0], args[1:]
		}
	}
	switch cmd {
	case "peek", "peek-screen":
		extPeek(ctx, args)
	case "visual", "visual-snapshot":
		extVisual(ctx, args)
	case "query-region", "query_region":
		extQueryRegion(ctx, args)
	case "batch-crawl", "batch_crawl", "crawl":
		extBatchCrawl(ctx, args)
	case "web-search", "web_search", "search":
		extWebSearch(ctx, args)
	case "net", "network":
		if len(args) == 0 || (args[0] != "detail" && args[0] != "request-detail") {
			return false
		}
		extNetworkDetail(ctx, args[1:])
	case "flow", "flows":
		if len(args) == 0 || args[0] != "explore" {
			return false
		}
		extFlowExplore(ctx, args[1:])
	default:
		return false
	}
	return true
}

type browserContext struct {
	opt     parsedOptions
	browser *rod.Browser
}

func extPage(ctx *browserContext) *rod.Page {
	p, err := browser.ResolvePage(ctx.browser, ctx.opt.tabTarget)
	check(ctx.opt.asJSON, err)
	return p
}

func extPeek(ctx *browserContext, args []string) {
	shot := ctx.opt.out
	if shot == "" && len(args) > 0 && looksLikePath(args[0]) {
		shot = args[0]
	}
	res, err := browser.PeekScreen(extPage(ctx), ctx.opt.maxChars, shot)
	check(ctx.opt.asJSON, err)
	outputJSON(res)
}

func extVisual(ctx *browserContext, args []string) {
	out := ctx.opt.out
	if out == "" && len(args) > 0 {
		out = args[0]
	}
	res, err := browser.VisualSnapshot(extPage(ctx), out, ctx.opt.fullPage)
	check(ctx.opt.asJSON, err)
	outputJSON(res)
}

func extQueryRegion(ctx *browserContext, args []string) {
	if len(args) < 1 {
		fatal(ctx.opt.asJSON, "usage: browsercontrol cdp query-region <css-selector>")
	}
	res, err := browser.QueryRegion(extPage(ctx), args[0], ctx.opt.limit)
	check(ctx.opt.asJSON, err)
	if ctx.opt.asJSON {
		outputJSON(res)
		return
	}
	for _, node := range res.Nodes {
		fmt.Printf("[%d] <%s role=%s> %q\n", node.ID, node.Tag, node.Role, node.Name)
	}
}

func extNetworkDetail(ctx *browserContext, args []string) {
	if len(args) < 1 {
		fatal(ctx.opt.asJSON, "usage: browsercontrol cdp net detail <index|url-fragment> [body]")
	}
	includeBody := len(args) > 1 && (args[1] == "body" || args[1] == "include-body" || args[1] == "includeBody=true")
	res, err := browser.NetworkEntryDetail(extPage(ctx), args[0], includeBody)
	check(ctx.opt.asJSON, err)
	outputJSON(res)
}

func extBatchCrawl(ctx *browserContext, args []string) {
	urls := expandURLArgs(args)
	if len(urls) == 0 {
		fatal(ctx.opt.asJSON, "usage: browsercontrol cdp batch-crawl <url...|@urls.txt>")
	}
	concurrency := 3
	if ctx.opt.limit != 20 {
		concurrency = ctx.opt.limit
	}
	res, err := browser.BatchCrawl(ctx.browser, urls, concurrency, ctx.opt.maxChars)
	check(ctx.opt.asJSON, err)
	outputJSON(res)
}

func extWebSearch(ctx *browserContext, args []string) {
	if len(args) < 1 {
		fatal(ctx.opt.asJSON, "usage: browsercontrol cdp web-search <query>")
	}
	res, err := browser.WebSearch(extPage(ctx), strings.Join(args, " "), ctx.opt.limit)
	check(ctx.opt.asJSON, err)
	outputJSON(res)
}

func extFlowExplore(ctx *browserContext, args []string) {
	if len(args) < 1 {
		fatal(ctx.opt.asJSON, "usage: browsercontrol cdp flow explore <flow-id|flow.json>")
	}
	steps, err := browser.LoadFlow(args[0])
	check(ctx.opt.asJSON, err)
	p := extPage(ctx)
	report, runErr := browser.RunFlow(p, steps)
	snapshot, _ := browser.TakeSnapshot(p)
	peek, _ := browser.PeekScreen(p, ctx.opt.maxChars, "")
	result := map[string]any{"report": report, "snapshot": snapshot, "peek": peek}
	if runErr != nil {
		result["success"] = false
		result["error"] = runErr.Error()
		outputJSON(result)
		os.Exit(1)
	}
	result["success"] = true
	outputJSON(result)
}

func expandURLArgs(args []string) []string {
	var urls []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "@") {
			data, err := os.ReadFile(strings.TrimPrefix(arg, "@"))
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if line != "" && !strings.HasPrefix(line, "#") {
					urls = append(urls, line)
				}
			}
			continue
		}
		urls = append(urls, arg)
	}
	return urls
}

func looksLikePath(value string) bool {
	return strings.Contains(value, "/") || strings.Contains(value, "\\") || strings.Contains(value, ".")
}

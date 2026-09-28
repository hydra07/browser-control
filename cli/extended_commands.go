package main

import (
	"os"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/browser"
)

func init() {
	if len(os.Args) < 2 {
		return
	}
	cmd := os.Args[1]
	opt := parseFlags(cmd, os.Args[2:])
	args := opt.args

	cfg := browser.DefaultConfig()
	cfg.Port = opt.port
	cfg.Headless = opt.headless

	runWithBrowser := func(fn func(*browserContext)) {
		b, err := browser.GetBrowser(cfg)
		if err != nil {
			fatal(opt.asJSON, "failed to initialize Chrome: %v", err)
		}
		fn(&browserContext{opt: opt, browser: b})
		os.Exit(0)
	}

	switch cmd {
	case "peek", "peek-screen":
		runWithBrowser(func(ctx *browserContext) { extPeek(ctx, args) })
	case "visual", "visual-snapshot":
		runWithBrowser(func(ctx *browserContext) { extVisual(ctx, args) })
	case "query-region", "query_region":
		runWithBrowser(func(ctx *browserContext) { extQueryRegion(ctx, args) })
	case "batch-crawl", "batch_crawl", "crawl":
		runWithBrowser(func(ctx *browserContext) { extBatchCrawl(ctx, args) })
	case "web-search", "web_search", "search":
		runWithBrowser(func(ctx *browserContext) { extWebSearch(ctx, args) })
	case "page":
		if len(args) == 0 {
			return
		}
		switch args[0] {
		case "peek", "peek-screen":
			runWithBrowser(func(ctx *browserContext) { extPeek(ctx, args[1:]) })
		case "visual", "visual-snapshot":
			runWithBrowser(func(ctx *browserContext) { extVisual(ctx, args[1:]) })
		case "query-region", "query_region":
			runWithBrowser(func(ctx *browserContext) { extQueryRegion(ctx, args[1:]) })
		case "web-search", "web_search", "search":
			runWithBrowser(func(ctx *browserContext) { extWebSearch(ctx, args[1:]) })
		}
	case "net", "network":
		if len(args) > 0 && (args[0] == "detail" || args[0] == "request-detail") {
			runWithBrowser(func(ctx *browserContext) { extNetworkDetail(ctx, args[1:]) })
		}
	case "flow", "flows":
		if len(args) > 0 && args[0] == "explore" {
			runWithBrowser(func(ctx *browserContext) { extFlowExplore(ctx, args[1:]) })
		}
	}
}

type browserContext struct {
	opt     parsedOptions
	browser any
}

func (ctx *browserContext) page() *rodPageCompat {
	return nil
}

func extPage(ctx *browserContext) *rod.Page {
	b := ctx.browser.(*rod.Browser)
	p, err := browser.ResolvePage(b, ctx.opt.tabTarget)
	check(ctx.opt.asJSON, err)
	return p
}

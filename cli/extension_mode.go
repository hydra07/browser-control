package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
)

func init() {
	if len(os.Args) < 2 {
		return
	}
	cmd := os.Args[1]
	if cmd != "extension" && cmd != "ext" {
		return
	}
	handleExtensionMode(os.Args[2:])
	os.Exit(0)
}

type extensionOptions struct {
	host      string
	port      int
	url       string
	token     string
	tokenFile string
	timeout   time.Duration
	asJSON    bool
	help      bool
	args      []string
}

type convenienceArgs struct {
	pos     []string
	payload map[string]any
	help    bool
}

func handleExtensionMode(args []string) {
	opt := parseExtensionFlags(args)
	if len(opt.args) == 0 || opt.args[0] == "help" || opt.help {
		if len(opt.args) > 0 && opt.args[0] != "help" {
			printExtensionSubcommandUsage(opt.args[0])
			return
		}
		if len(opt.args) > 1 {
			printExtensionSubcommandUsage(opt.args[1])
			return
		}
		printExtensionUsage()
		return
	}

	cfg := extbridge.Config{
		Host:      opt.host,
		Port:      opt.port,
		BaseURL:   opt.url,
		Token:     opt.token,
		TokenFile: opt.tokenFile,
		Timeout:   opt.timeout,
	}

	subcmd := strings.ReplaceAll(opt.args[0], "-", "_")
	rest := opt.args[1:]
	if hasHelp(rest) {
		printExtensionSubcommandUsage(subcmd)
		return
	}

	switch subcmd {
	case "serve", "server", "bridge":
		server, tokenInfo, err := extbridge.NewServer(cfg)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(map[string]any{"listening": fmt.Sprintf("%s:%d", extbridge.NormalizeConfig(cfg).Host, extbridge.NormalizeConfig(cfg).Port), "tokenSource": tokenInfo.Source})
		} else {
			normalized := extbridge.NormalizeConfig(cfg)
			fmt.Printf("BrowserControl extension bridge listening on http://%s:%d\n", normalized.Host, normalized.Port)
			fmt.Printf("Token source: %s\n", tokenInfo.Source)
			fmt.Println("Keep this process running, then reload/open the Chrome extension.")
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		check(opt.asJSON, server.ListenAndServe(ctx))
	case "token", "auth_token":
		info, err := extbridge.LoadToken(cfg)
		check(opt.asJSON, err)
		if opt.asJSON {
			outputJSON(info)
			return
		}
		fmt.Println(info.Token)
	case "status":
		client, _, err := extbridge.NewClient(cfg)
		check(opt.asJSON, err)
		data, err := client.Status()
		check(opt.asJSON, err)
		printBridgeResponse(data, opt.asJSON)
	case "exec", "execute", "call", "raw":
		handleExtensionExec(cfg, opt, rest)
	default:
		handleExtensionShortcut(cfg, opt, subcmd, rest)
	}
}

func handleExtensionExec(cfg extbridge.Config, opt extensionOptions, rest []string) {
	if len(rest) < 1 {
		fatal(opt.asJSON, "usage: browsercontrol extension exec <command> [key=value|--flag value|@payload.json ...]")
	}
	cmd := strings.ReplaceAll(rest[0], "-", "_")
	payload, err := extbridge.ParsePayloadArgs(rest[1:])
	check(opt.asJSON, err)
	runExtensionCommand(cfg, opt, cmd, payload)
}

func handleExtensionShortcut(cfg extbridge.Config, opt extensionOptions, subcmd string, rest []string) {
	parsed, err := parseConvenienceArgs(rest)
	check(opt.asJSON, err)
	if parsed.help {
		printExtensionSubcommandUsage(subcmd)
		return
	}
	payload := parsed.payload
	cmd := subcmd

	switch subcmd {
	case "open", "navigate", "nav":
		cmd = "navigate"
		if len(parsed.pos) > 0 {
			payload["url"] = parsed.pos[0]
		}
		if payload["url"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension open <url> [--new-tab]")
		}
	case "snapshot", "snap":
		cmd = "snapshot"
		setDefault(payload, "compact", true)
		setDefault(payload, "semantic", true)
	case "screenshot", "shot":
		cmd = "screenshot"
		setDefault(payload, "fullPage", true)
		setDefault(payload, "format", "png")
		if len(parsed.pos) > 0 {
			payload["out"] = parsed.pos[0]
		}
	case "read", "reading", "reading_mode", "text":
		cmd = "reading_mode"
		setDefault(payload, "maxChars", 12000)
	case "find":
		cmd = "find"
		if len(parsed.pos) > 0 {
			payload["query"] = strings.Join(parsed.pos, " ")
		}
		if payload["query"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension find <query>")
		}
	case "select", "select_content":
		cmd = "select_content"
		if len(parsed.pos) > 0 {
			payload["selector"] = parsed.pos[0]
		}
		if payload["selector"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension select <css-selector>")
		}
	case "inspect", "inspect_element":
		cmd = "inspect_element"
		if len(parsed.pos) > 0 {
			applyTarget(payload, parsed.pos[0])
		}
	case "peek", "peek_screen":
		cmd = "peek_screen"
		setDefault(payload, "screenshot", false)
		setDefault(payload, "maxChars", 8000)
	case "visual", "visual_snapshot":
		cmd = "visual_snapshot"
	case "query_region", "region":
		cmd = "query_region"
		if len(parsed.pos) > 0 {
			payload["selector"] = parsed.pos[0]
		}
		if payload["selector"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension query-region <css-selector>")
		}
	case "click":
		cmd = "click"
		if len(parsed.pos) > 0 {
			applyTarget(payload, parsed.pos[0])
		}
	case "type":
		cmd = "type"
		if len(parsed.pos) > 0 {
			applyTarget(payload, parsed.pos[0])
		}
		if len(parsed.pos) > 1 {
			payload["text"] = strings.Join(parsed.pos[1:], " ")
		}
		if payload["text"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension type <target> <text>")
		}
	case "press", "key", "press_key":
		cmd = "press_key"
		if len(parsed.pos) > 0 {
			payload["key"] = parsed.pos[0]
		}
		if payload["key"] == nil {
			fatal(opt.asJSON, "usage: browsercontrol extension press <key>")
		}
	case "scroll":
		cmd = "scroll"
		if len(parsed.pos) == 1 {
			payload["deltaY"] = parsed.pos[0]
		} else if len(parsed.pos) >= 2 {
			payload["deltaX"] = parsed.pos[0]
			payload["deltaY"] = parsed.pos[1]
		}
		setDefault(payload, "deltaY", 800)
	case "drag":
		cmd = "drag"
		if len(parsed.pos) >= 4 {
			payload["fromX"] = parsed.pos[0]
			payload["fromY"] = parsed.pos[1]
			payload["toX"] = parsed.pos[2]
			payload["toY"] = parsed.pos[3]
		}
	case "tabs", "tab":
		cmd = mapTabsCommand(opt, payload, parsed.pos)
	case "network", "net":
		cmd = mapNetworkCommand(opt, payload, parsed.pos)
	case "flow", "flows":
		cmd = mapFlowCommand(opt, payload, parsed.pos)
	case "dev":
		cmd = mapDevCommand(opt, payload, parsed.pos)
	case "evidence", "start_capture", "stop_capture", "start_flow_recording", "stop_flow_recording", "flow_recording_status", "batch_crawl", "web_search", "network_requests", "network_request_detail", "network_clear", "dev_har", "dev_memory", "dev_process", "dev_layout", "dev_emulate", "dev_sandbox", "run_flow", "explore_flow", "list_tabs", "switch_tab", "close_tab":
		cmd = subcmd
	default:
		fatal(opt.asJSON, "unknown extension command %q; run 'browsercontrol extension help'", subcmd)
	}

	runExtensionCommand(cfg, opt, cmd, payload)
}

func runExtensionCommand(cfg extbridge.Config, opt extensionOptions, cmd string, payload map[string]any) {
	client, _, err := extbridge.NewClient(cfg)
	check(opt.asJSON, err)
	data, err := client.Execute(strings.ReplaceAll(cmd, "-", "_"), payload)
	check(opt.asJSON, err)
	printBridgeResponse(data, opt.asJSON)
}

func mapTabsCommand(opt extensionOptions, payload map[string]any, pos []string) string {
	action := "list"
	if len(pos) > 0 {
		action = strings.ReplaceAll(pos[0], "-", "_")
	}
	switch action {
	case "list", "ls":
		return "list_tabs"
	case "switch":
		if len(pos) > 1 {
			payload["tabId"] = pos[1]
		}
		return "switch_tab"
	case "close", "rm":
		if len(pos) > 1 {
			payload["tabId"] = pos[1]
		}
		return "close_tab"
	default:
		fatal(opt.asJSON, "unknown tabs action %q", action)
	}
	return "list_tabs"
}

func mapNetworkCommand(opt extensionOptions, payload map[string]any, pos []string) string {
	action := "list"
	if len(pos) > 0 {
		action = strings.ReplaceAll(pos[0], "-", "_")
	}
	switch action {
	case "list", "requests", "reqs":
		setDefault(payload, "limit", 50)
		return "network_requests"
	case "detail", "request_detail":
		if len(pos) > 1 {
			payload["requestId"] = pos[1]
		}
		return "network_request_detail"
	case "clear":
		return "network_clear"
	case "har":
		return "dev_har"
	default:
		fatal(opt.asJSON, "unknown network action %q", action)
	}
	return "network_requests"
}

func mapFlowCommand(opt extensionOptions, payload map[string]any, pos []string) string {
	action := "run"
	if len(pos) > 0 {
		action = strings.ReplaceAll(pos[0], "-", "_")
	}
	if len(pos) > 1 {
		mergeFileOrTarget(payload, pos[1])
	}
	switch action {
	case "run":
		return "run_flow"
	case "explore":
		return "explore_flow"
	case "record", "start_recording":
		return "start_flow_recording"
	case "stop", "stop_recording":
		return "stop_flow_recording"
	case "status", "recording_status":
		return "flow_recording_status"
	default:
		fatal(opt.asJSON, "unknown flow action %q", action)
	}
	return "run_flow"
}

func mapDevCommand(opt extensionOptions, payload map[string]any, pos []string) string {
	action := "layout"
	if len(pos) > 0 {
		action = strings.ReplaceAll(pos[0], "-", "_")
	}
	if len(pos) > 1 {
		payload["selector"] = pos[1]
	}
	switch action {
	case "layout":
		return "dev_layout"
	case "memory":
		return "dev_memory"
	case "process":
		return "dev_process"
	case "emulate":
		return "dev_emulate"
	case "sandbox":
		return "dev_sandbox"
	case "har":
		return "dev_har"
	default:
		fatal(opt.asJSON, "unknown dev action %q", action)
	}
	return "dev_layout"
}

func parseExtensionFlags(args []string) extensionOptions {
	var opt extensionOptions
	fs := flag.NewFlagSet("extension", flag.ContinueOnError)
	fs.StringVar(&opt.host, "host", extbridge.DefaultHost, "extension bridge host")
	fs.IntVar(&opt.port, "port", extbridge.DefaultPort, "extension bridge port")
	fs.StringVar(&opt.url, "url", "", "extension bridge base URL")
	fs.StringVar(&opt.token, "token", "", "daemon/extension bearer token")
	fs.StringVar(&opt.tokenFile, "token-file", "", "read bearer token from file")
	fs.DurationVar(&opt.timeout, "timeout", 30*time.Second, "request timeout")
	fs.BoolVar(&opt.asJSON, "json", false, "print JSON")
	fs.BoolVar(&opt.help, "help", false, "show help")
	fs.BoolVar(&opt.help, "h", false, "show help")
	if err := fs.Parse(reorderExtensionFlagArgs(args)); err != nil {
		os.Exit(1)
	}
	opt.args = fs.Args()
	return opt
}

func reorderExtensionFlagArgs(args []string) []string {
	boolFlags := map[string]bool{"--json": true, "--help": true, "-h": true}
	valueFlags := map[string]bool{"--host": true, "--port": true, "--url": true, "--token": true, "--token-file": true, "--timeout": true}
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

func parseConvenienceArgs(args []string) (convenienceArgs, error) {
	parsed := convenienceArgs{payload: map[string]any{}}
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" {
			continue
		}
		if arg == "--help" || arg == "-h" || arg == "help" {
			parsed.help = true
			continue
		}
		if strings.HasPrefix(arg, "--") {
			key, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			key = extbridge.NormalizePayloadKey(key)
			if hasValue {
				object, err := extbridge.ParsePayloadArgs([]string{key + "=" + value})
				if err != nil {
					return parsed, err
				}
				mergePayload(parsed.payload, object)
				continue
			}
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") && shouldFlagConsumeValue(key) {
				object, err := extbridge.ParsePayloadArgs([]string{key + "=" + args[i+1]})
				if err != nil {
					return parsed, err
				}
				mergePayload(parsed.payload, object)
				i++
				continue
			}
			parsed.payload[key] = true
			continue
		}
		if strings.HasPrefix(arg, "@") || strings.HasPrefix(arg, "{") || strings.Contains(arg, "=") {
			object, err := extbridge.ParsePayloadArgs([]string{arg})
			if err != nil {
				return parsed, err
			}
			mergePayload(parsed.payload, object)
			continue
		}
		parsed.pos = append(parsed.pos, arg)
	}
	return parsed, nil
}

func shouldFlagConsumeValue(key string) bool {
	switch key {
	case "out", "format", "selector", "query", "key", "url", "ref", "documentId", "nodeId", "requestId", "tabId", "text", "maxChars", "limit", "deltaX", "deltaY", "fromX", "fromY", "toX", "toY", "device", "mode", "domain", "timeoutMs", "focus", "network", "concurrency", "maxCharsPerUrl":
		return true
	default:
		return false
	}
}

func applyTarget(payload map[string]any, target string) {
	if target == "" || hasAny(payload, "nodeId", "ref", "selector", "target") {
		return
	}
	if nodeID, err := strconv.Atoi(target); err == nil {
		payload["nodeId"] = nodeID
		return
	}
	if strings.HasPrefix(target, "ref:") {
		payload["ref"] = strings.TrimPrefix(target, "ref:")
		return
	}
	if looksLikeSelector(target) {
		payload["selector"] = target
		return
	}
	payload["ref"] = target
}

func looksLikeSelector(value string) bool {
	return strings.HasPrefix(value, "#") || strings.HasPrefix(value, ".") || strings.HasPrefix(value, "[") || strings.Contains(value, ">") || strings.Contains(value, " ")
}

func mergeFileOrTarget(payload map[string]any, value string) {
	if value == "" {
		return
	}
	if strings.HasPrefix(value, "@") || strings.HasSuffix(strings.ToLower(value), ".json") {
		payload["flow"] = strings.TrimPrefix(value, "@")
		return
	}
	payload["id"] = value
}

func setDefault(payload map[string]any, key string, value any) {
	if _, ok := payload[key]; !ok {
		payload[key] = value
	}
}

func hasAny(payload map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, ok := payload[key]; ok {
			return true
		}
	}
	return false
}

func mergePayload(dst, src map[string]any) {
	for k, v := range src {
		dst[k] = v
	}
}

func hasHelp(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" || arg == "help" {
			return true
		}
	}
	return false
}

func printExtensionUsage() {
	fmt.Print(`BrowserControl extension mode - AI-friendly CLI for the Chrome extension

Usage:
  browsercontrol extension serve [flags]
  browsercontrol extension status [flags]
  browsercontrol extension token [flags]

AI-friendly shortcuts:
  browsercontrol extension snapshot [--compact] [--semantic]
  browsercontrol extension screenshot [out.png] [--full] [--format png]
  browsercontrol extension open <url> [--new-tab]
  browsercontrol extension click <nodeId|ref|selector>
  browsercontrol extension type <nodeId|ref|selector> <text>
  browsercontrol extension press <key>
  browsercontrol extension scroll [dy]
  browsercontrol extension read [--max-chars 12000]
  browsercontrol extension find <query>
  browsercontrol extension select <css-selector>
  browsercontrol extension inspect <nodeId|ref|selector>
  browsercontrol extension network list|detail|clear|har [...]
  browsercontrol extension tabs list|switch|close [...]
  browsercontrol extension flow run|explore <flow.json|flow-id>
  browsercontrol extension dev layout|memory|process|emulate|sandbox [...]

Raw bridge escape hatch:
  browsercontrol extension exec <command> [key=value|--flag value|@payload.json ...]

Recommended AI setup:
  $BC = "D:\\dev\\dotfiles\\tool\\browsercontrol\\cli\\browsercontrol.exe"
  $BC_TOKEN_FILE = "D:\\dev\\dotfiles\\tool\\browsercontrol\\data\\daemon-auth-token"
  function bc { & $BC extension @args --token-file $BC_TOKEN_FILE --json }

Recommended AI loop:
  bc status
  bc snapshot
  bc click 1
  bc snapshot

Examples:
  browsercontrol extension status --json
  browsercontrol extension snapshot --json
  browsercontrol extension screenshot .local/screenshot/AUTH001.png --json
  browsercontrol extension click 1 --json
  browsercontrol extension type 2 "hello world" --json
  browsercontrol extension press Enter --json
  browsercontrol extension network list --filter api --limit 50 --json
  browsercontrol extension exec run_flow @flow.json --return-snapshot --json

Payload rules:
  For shortcuts, normal flags work: --out file, --full, --format png.
  For raw exec, both normal flags and key=value work.
  Example raw exec: browsercontrol extension exec screenshot --full --format png --out shot.png --json

Global flags:
  --host <host>              default 127.0.0.1
  --port <port>              default 8765
  --url <url>                bridge URL for status/exec clients
  --token <token>            bearer token override
  --token-file <path>        token file override
  --timeout <duration>       default 30s
  --json                     pretty-print JSON output
`)
}

func printExtensionSubcommandUsage(command string) {
	command = strings.ReplaceAll(command, "-", "_")
	switch command {
	case "status":
		fmt.Println("Usage: browsercontrol extension status [--json] [--token-file path]")
	case "serve", "server", "bridge":
		fmt.Println("Usage: browsercontrol extension serve [--host 127.0.0.1] [--port 8765] [--token-file path]")
	case "token", "auth_token":
		fmt.Println("Usage: browsercontrol extension token [--token-file path]")
	case "snapshot", "snap":
		fmt.Println("Usage: browsercontrol extension snapshot [--compact] [--semantic] [--json]")
	case "screenshot", "shot":
		fmt.Println("Usage: browsercontrol extension screenshot [out.png] [--full] [--format png] [--json]")
	case "open", "navigate", "nav":
		fmt.Println("Usage: browsercontrol extension open <url> [--new-tab] [--json]")
	case "click":
		fmt.Println("Usage: browsercontrol extension click <nodeId|ref|selector> [--document-id id] [--confirm-risky] [--json]")
	case "type":
		fmt.Println("Usage: browsercontrol extension type <nodeId|ref|selector> <text> [--json]")
	case "network", "net":
		fmt.Println("Usage: browsercontrol extension network list|detail|clear|har [args] [--json]")
	case "exec", "execute", "call", "raw":
		fmt.Println("Usage: browsercontrol extension exec <command> [key=value|--flag value|@payload.json ...] [--json]")
	default:
		printExtensionUsage()
	}
}

func printBridgeResponse(data []byte, asJSON bool) {
	if asJSON {
		fmt.Println(extbridge.PrettyPrintJSON(data))
		return
	}
	fmt.Println(extbridge.PrettyPrintJSON(data))
}

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
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
	args      []string
}

func handleExtensionMode(args []string) {
	opt := parseExtensionFlags(args)
	if len(opt.args) == 0 || opt.args[0] == "help" || opt.args[0] == "-h" || opt.args[0] == "--help" {
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

	subcmd := opt.args[0]
	rest := opt.args[1:]
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
	case "token", "auth-token":
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
	case "exec", "execute", "call":
		if len(rest) < 1 {
			fatal(opt.asJSON, "usage: browsercontrol extension exec <command> [key=value|@payload.json ...]")
		}
		cmd := strings.ReplaceAll(rest[0], "-", "_")
		payload, err := extbridge.ParsePayloadArgs(rest[1:])
		check(opt.asJSON, err)
		client, _, err := extbridge.NewClient(cfg)
		check(opt.asJSON, err)
		data, err := client.Execute(cmd, payload)
		check(opt.asJSON, err)
		printBridgeResponse(data, opt.asJSON)
	default:
		fatal(opt.asJSON, "unknown extension subcommand %q", subcmd)
	}
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
	if err := fs.Parse(reorderExtensionFlagArgs(args)); err != nil {
		os.Exit(1)
	}
	opt.args = fs.Args()
	return opt
}

func reorderExtensionFlagArgs(args []string) []string {
	boolFlags := map[string]bool{"--json": true}
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

func printExtensionUsage() {
	fmt.Print(`BrowserControl extension mode - CLI controls the Chrome extension, not direct CDP

Usage:
  browsercontrol extension serve [flags]
  browsercontrol extension status [flags]
  browsercontrol extension token [flags]
  browsercontrol extension exec <command> [payload] [flags]

Examples:
  browsercontrol extension serve
  browsercontrol extension status --json
  browsercontrol extension exec snapshot compact=true --json
  browsercontrol extension exec click nodeId=1 --json
  browsercontrol extension exec type nodeId=2 text="hello" --json
  browsercontrol extension exec run_flow @flow.json returnSnapshot=true --json

Payload syntax:
  key=value                  value is parsed as JSON when possible
  @file.json                 merge a JSON object from file
  '{"key":"value"}'          merge inline JSON object
  key=@file                  value from file, JSON-decoded when possible

Flags:
  --host <host>              default 127.0.0.1
  --port <port>              default 8765, same as the old Bun daemon
  --url <url>                bridge URL for status/exec clients
  --token <token>            bearer token override
  --token-file <path>        token file override
  --timeout <duration>       default 30s
  --json                     pretty-print JSON output
`)
}

func printBridgeResponse(data []byte, asJSON bool) {
	if asJSON {
		fmt.Println(extbridge.PrettyPrintJSON(data))
		return
	}
	fmt.Println(extbridge.PrettyPrintJSON(data))
}

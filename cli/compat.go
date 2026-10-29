package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
)

func runCLI(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "version", "--version":
			fmt.Println("browsercontrol", version)
			return 0
		case "direct":
			return runDirectCLI(args[1:])
		case "browser":
			return runDirectCLI(args)
		case "extension", "ext":
			return runExtension(args[1:])
		case "cdp":
			runCDP(args[1:])
			return 0
		case "dev":
			if len(args) > 1 && (args[1] == commandDumpFixture || args[1] == commandBenchRender) {
				return runDirectCLI(args)
			}
		case "serve", "server", "bridge":
			return reportError(globalOpts{asJSON: jsonRequested(args)}, usagef("use 'browsercontrol extension serve' only for an optional persistent bridge; normal commands connect on demand"))
		}
	}
	return runExtensionCLI(args, true)
}

// Command-owned bridges restore the existing browser path without spawning a daemon.
func (s *session) ensureCommandBridge(client *extbridge.Client) error {
	if _, err := client.Status(); err == nil {
		return nil
	} else {
		var op *net.OpError
		if !errors.As(err, &op) || op.Op != "dial" {
			return err
		}
	}
	cfg := extbridge.NormalizeConfig(s.g.cfg)
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") ||
		u.Hostname() != "127.0.0.1" || u.Port() != strconv.Itoa(cfg.Port) || cfg.Host != "127.0.0.1" {
		return errors.New("on-demand bridge is limited to the selected 127.0.0.1 port; start a custom endpoint explicitly")
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		// A concurrent CLI may have won the bind; only inspect status, never replay input here.
		for range 10 {
			if _, statusErr := client.Status(); statusErr == nil {
				return nil
			}
			time.Sleep(25 * time.Millisecond)
		}
		return err
	}
	cfg.Token = client.Token()
	cfg.Quiet = true
	server, _, err := extbridge.NewServer(cfg)
	if err != nil {
		_ = listener.Close()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	s.bridgeClose = func() error { cancel(); return <-done }
	s.g.waitSet = true
	return nil
}

func directHelp(text string) string {
	text = strings.ReplaceAll(text, "browsercontrol ", "browsercontrol direct ")
	for _, prefix := range []string{"direct", "extension", "cdp"} {
		text = strings.ReplaceAll(text, "browsercontrol direct "+prefix, "browsercontrol "+prefix)
	}
	return text
}

func compatibilityHelp(text string) string {
	text = strings.ReplaceAll(text, "browsercontrol extension - legacy extension adapter (track X)", "browsercontrol - control your current Chrome through its extension")
	text = strings.ReplaceAll(text, "Usage: browsercontrol extension <command>", "Usage: browsercontrol <command>")
	text = strings.ReplaceAll(text, "status [--wait 20s]    serve    token", "status [--wait 20s]    token")
	return text + "\nDefault: current Chrome via extension; a local bridge lives only for this command when needed.\nDirect CDP agent profile: browsercontrol direct <command> (explicit opt-in).\nOptional persistent bridge: browsercontrol extension serve.\n"
}

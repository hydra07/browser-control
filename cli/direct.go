package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/bench"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

const directUsage = `browsercontrol - on-demand browser control through direct CDP

Usage: browsercontrol browser <start|status|stop> [--profile <name>] [--json]

  browser start --profile agent       launch/reuse an owned, persistent Chrome profile
  browser status --profile agent      inspect current ownership and process health
  browser stop --profile agent        close only the verified owned Chrome process
  open <url> [--new-tab]              open an HTTP(S) page in an owned agent profile
  snapshot [--grep text] [--limit n]  observe controls; IDs work across CLI processes
  click <id|css>                     click an observed, unchanged physical node
  type <id|css> <text> [--clear]      enter text; fill always replaces the value
  press <key|Control+a>              dispatch a key chord with bounded key-release cleanup
  tabs [list|new|switch|close]        inspect/select tabs by target ID or listed index
  read | wait <text|css> | scroll dy  inspect text, wait for a condition, or scroll
  screenshot [file.png] [--full]      save PNG to a local artifact path
  pending | ack <id> --ack-unknown    inspect uncertain actions, acknowledge after inspection
  dev dump-fixture <url|fixture:name>  save bounded, sanitized DOM/AX/frame fixtures
  dev bench-render [file|directory]   measure offline projection/render bytes, tokens and time

Flags: --session-id <id> --timeout 30s --json --help
Start options: --executable <Chrome path> --headless

Each command connects directly and exits. The Chrome profile keeps its login state.
Attach to an existing user Chrome awaits consent/endpoint validation (R0-S3/S6).
Numeric node IDs require a fresh snapshot after navigation; actions never fall back implicitly.
Legacy adapter: browsercontrol extension <command> (track X).
`

type directOptions struct {
	json, help, headless, noSandbox bool
	allowPrivate                    bool
	sessionID, profile, executable  string
	out, target                     string
	maxNodes, maxFrames             int
	bench                           bench.Options
	benchFlags                      bool
	timeout                         time.Duration
	positionals                     []string
	tab                             string
	ackUnknown                      bool
	benchOnly                       bool
	newTab, full, clear, snap       bool
	maxChars                        int
}

func runDirectCLI(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "extension", "ext":
			return runExtension(args[1:])
		case "cdp":
			runCDP(args[1:])
			return 0
		}
	}
	options, err := parseDirectOptions(args)
	g := globalOpts{asJSON: options.json}
	if err != nil {
		g.asJSON = jsonRequested(args)
		return reportError(g, err)
	}
	if options.help || len(options.positionals) == 0 || options.positionals[0] == "help" {
		help := directUsage
		if len(options.positionals) > 0 && options.positionals[0] == commandDev {
			help = devUsage
			if len(options.positionals) > 1 {
				switch options.positionals[1] {
				case commandDumpFixture:
					help = fixtureUsage
				case commandBenchRender:
					help = benchUsage
				}
			}
		}
		if len(options.positionals) > 0 {
			name := options.positionals[0]
			if name == "help" && len(options.positionals) > 1 {
				name = options.positionals[1]
			}
			if isAgentCommand(name) {
				help = agentHelp(name)
			}
		}
		printHelp(g, directHelp(help))
		return 0
	}
	if options.positionals[0] == commandDev {
		if options.tab != "" || options.newTab || options.full || options.clear || options.snap || options.maxChars != 0 || options.ackUnknown {
			return reportError(g, usagef("agent flags do not apply to developer commands"))
		}
		if len(options.positionals) > 1 && options.positionals[1] == commandBenchRender {
			return runBenchCommand(options, g)
		}
		return runFixtureCommand(options, g)
	}
	if isAgentCommand(options.positionals[0]) {
		return runAgentCommand(options, g)
	}
	if options.tab != "" || options.newTab || options.full || options.clear || options.snap || options.maxChars != 0 || options.ackUnknown {
		return reportError(g, usagef("agent flags require an agent command"))
	}
	switch options.positionals[0] {
	case "serve", "server", "bridge", "token":
		return reportError(g, usagef("%q belongs only to the explicit extension adapter (track X); direct CDP does not use a bridge", options.positionals[0]))
	}
	if options.positionals[0] != "browser" {
		return reportError(g, usagef("direct command %q is not available yet; see PLANS.md and 'browsercontrol help'; the legacy adapter requires the explicit 'extension' prefix", options.positionals[0]))
	}
	if options.allowPrivate || options.out != "" || options.target != "" || options.maxNodes != 0 || options.maxFrames != 0 {
		return reportError(g, usagef("fixture flags apply only to dev dump-fixture"))
	}
	if options.benchFlags {
		return reportError(g, usagef("benchmark flags apply only to dev bench-render"))
	}
	if len(options.positionals) != 2 {
		return reportError(g, usagef("usage: browsercontrol browser <start|status|stop> [--profile <name>]"))
	}
	operation := options.positionals[1]
	if operation == "attach" {
		return reportError(g, errors.New("user-Chrome attach is pending R0-S3/S6 consent and endpoint validation; use an agent profile with 'browsercontrol browser start'"))
	}
	if operation != "start" && operation != "status" && operation != "stop" {
		return reportError(g, usagef("unknown browser operation %q", operation))
	}
	if operation != "start" && (options.executable != "" || options.headless || options.noSandbox) {
		return reportError(g, usagef("--executable, --headless and --no-sandbox apply only to browser start"))
	}
	ctx, interrupt := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer interrupt()
	ctx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()
	info, err := executeBrowserLifecycle(ctx, options, operation)
	if err != nil {
		return reportError(g, err)
	}
	status := "stopped"
	if info.Running {
		status = "running"
	}
	(&session{g: g}).print(output{data: info, text: fmt.Sprintf("%s %s · browser %s · pid %d", info.Profile, status, info.ID, info.PID)})
	return 0
}

func parseDirectOptions(args []string) (directOptions, error) {
	options := directOptions{timeout: 30 * time.Second, sessionID: os.Getenv("BROWSERCONTROL_SESSION_ID"), bench: bench.DefaultOptions()}
	if options.sessionID == "" {
		options.sessionID = "go-cli"
	}
	for i := 0; i < len(args); i++ {
		argument := args[i]
		if argument == "--" {
			options.positionals = append(options.positionals, args[i+1:]...)
			break
		}
		if argument == "-h" {
			options.help = true
			continue
		}
		if !strings.HasPrefix(argument, "--") {
			options.positionals = append(options.positionals, argument)
			continue
		}
		name, value, inline := strings.Cut(argument[2:], "=")
		var err error
		switch name {
		case "json", "help", "headless", "no-sandbox", "allow-private", "new-tab", "full", "clear", "snap", "ack-unknown":
			var enabled bool
			enabled, err = parseFlagBool(value, inline)
			switch name {
			case "json":
				options.json = enabled
			case "help":
				options.help = enabled
			case "headless":
				options.headless = enabled
			case "no-sandbox":
				options.noSandbox = enabled
			case "allow-private":
				options.allowPrivate = enabled
			case "new-tab":
				options.newTab = enabled
			case "full":
				options.full = enabled
			case "clear":
				options.clear = enabled
			case "snap":
				options.snap = enabled
			case "ack-unknown":
				options.ackUnknown = enabled
			}
		case "profile", "executable", "session-id", "timeout", "out", "target", "tab", "max-chars", "max-nodes", "max-frames", "runs", "warmup", "encoding", "grep", "limit":
			if !inline && i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				value = args[i]
			}
			if value == "" {
				return options, usagef("--%s needs a value", name)
			}
			switch name {
			case "tab":
				options.tab = value
			case "max-chars":
				options.maxChars, err = strconv.Atoi(value)
				if err == nil && (options.maxChars < 1 || options.maxChars > 100000) {
					err = errors.New("must be between 1 and 100000")
				}
			case "runs", "warmup", "limit":
				if name != "limit" {
					options.benchOnly = true
				}
				options.benchFlags = true
				var parsed int
				parsed, err = strconv.Atoi(value)
				if err != nil {
					err = errors.New("must be an integer")
				} else {
					switch name {
					case "runs":
						options.bench.Runs = parsed
					case "warmup":
						options.bench.Warmup = parsed
					case "limit":
						options.bench.Limit = parsed
					}
				}
			case "encoding":
				options.benchOnly = true
				options.benchFlags, options.bench.Encoding = true, value
			case "grep":
				options.benchFlags, options.bench.Grep = true, value
			case "profile":
				options.profile = value
			case "executable":
				options.executable = value
			case "session-id":
				options.sessionID = value
			case "out":
				options.out = value
			case "target":
				options.target = value
			case "max-nodes", "max-frames":
				limit := 100000
				if name == "max-frames" {
					limit = 128
				}
				budget, parseErr := strconv.Atoi(value)
				if parseErr != nil || budget < 1 || budget > limit {
					err = fmt.Errorf("must be an integer between 1 and %d", limit)
				} else if name == "max-nodes" {
					options.maxNodes = budget
				} else {
					options.maxFrames = budget
				}
			case "timeout":
				options.timeout, err = time.ParseDuration(value)
				if err == nil && (options.timeout <= 0 || options.timeout > 2*time.Minute) {
					err = errors.New("must be greater than zero and at most 120s")
				}
			}
		default:
			return options, usagef("unknown direct-CDP flag --%s", name)
		}
		if err != nil {
			return options, usagef("--%s: %v", name, err)
		}
	}
	if err := sessionstore.ValidateID(options.sessionID); err != nil {
		return options, usagef("invalid session: %v", err)
	}
	if options.profile != "" {
		if err := sessionstore.ValidateID(options.profile); err != nil {
			return options, usagef("invalid profile: %v", err)
		}
	}
	return options, nil
}

func executeBrowserLifecycle(ctx context.Context, options directOptions, operation string) (sessionstore.BrowserInfo, error) {
	root, err := directStoreRoot()
	if err != nil {
		return sessionstore.BrowserInfo{}, err
	}
	store, err := sessionstore.NewStore(root, options.sessionID)
	if err != nil {
		return sessionstore.BrowserInfo{}, err
	}
	lock, err := store.Acquire(ctx)
	if err != nil {
		return sessionstore.BrowserInfo{}, err
	}
	defer lock.Close()
	state, err := store.Load()
	if errors.Is(err, os.ErrNotExist) {
		state = sessionstore.State{SchemaVersion: sessionstore.SchemaVersion, ID: options.sessionID}
	} else if err != nil {
		return sessionstore.BrowserInfo{}, err
	}
	permissions := state.EffectivePermissions()
	if operation == "status" {
		if err := permissions.Check(sessionstore.Read, ""); err != nil {
			return sessionstore.BrowserInfo{}, err
		}
	} else if !permissions.Act {
		return sessionstore.BrowserInfo{}, fmt.Errorf("%w: browser %s requires act", sessionstore.ErrPermission, operation)
	}
	profile := options.profile
	if profile == "" && state.Browser != nil {
		profile = state.Browser.Profile
	}
	if profile == "" {
		profile = "agent"
	}
	manager, err := sessionstore.NewBrowserManager(root)
	if err != nil {
		return sessionstore.BrowserInfo{}, err
	}
	var info sessionstore.BrowserInfo
	switch operation {
	case "start":
		info, err = manager.Start(ctx, sessionstore.BrowserOptions{Profile: profile, Executable: options.executable, Headless: options.headless, NoSandbox: options.noSandbox})
	case "status":
		info, err = manager.Status(ctx, profile)
	case "stop":
		if state.Browser == nil || state.Browser.Profile != profile {
			return sessionstore.BrowserInfo{}, errors.New("browser_not_owned: session has no ownership binding for this profile")
		}
		info, err = manager.StopOwned(ctx, *state.Browser)
	}
	if err == nil && operation == "start" {
		state.Browser = &sessionstore.BrowserBinding{Mode: "agent", Profile: profile, ID: info.ID, Process: sessionstore.OwnedProcess{PID: info.PID, Started: info.Started, Profile: info.ProfilePath}}
		if saveErr := store.Save(state); saveErr != nil {
			return info, fmt.Errorf("browser %s started as pid %d but session binding was not saved; inspect browser status: %w", info.ID, info.PID, saveErr)
		}
	}
	return info, err
}

func directStoreRoot() (string, error) {
	if root := os.Getenv("BROWSERCONTROL_HOME"); root != "" {
		return root, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".browsercontrol"), nil
}

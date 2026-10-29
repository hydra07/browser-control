package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

const (
	commandDev         = "dev"
	commandDumpFixture = "dump-fixture"
	fixtureUsage       = `Usage: browsercontrol dev dump-fixture <url|fixture:name> [--out <file.json>]

Requires a session bound by 'browsercontrol browser start'.
Default: navigate in a disposable anonymous context; never reuse profile credentials.
Private: --allow-private reads one existing page matching the exact URL, without navigating.
Private output stays under gitignored data/fixtures/private/. --target <id> disambiguates.

Flags: --session-id <id> --profile <name> --timeout 30s --json --help
Limits: --max-nodes 20000 (DOM+AX, maximum 100000) --max-frames 32 (maximum 128)
Output: one compact result with the file path and counts; capture data stays in the file.
Existing output files are never overwritten. Truncation/missing frames are explicit.
An observation is snapshot_at; DOM and AX are sequential observations, not an atomic checkpoint.

Built-ins: fixture:react-admin, fixture:article, fixture:virtual-table,
fixture:realtime-dashboard, fixture:modal, fixture:form, fixture:nested-frames,
fixture:shadow-dom, fixture:duplicate-controls, fixture:navigation
`
)

type fixtureResult struct {
	Path           string                  `json:"path"`
	Classification devtools.Classification `json:"classification"`
	Frames         int                     `json:"frames"`
	DOMNodes       int                     `json:"domNodes"`
	AXNodes        int                     `json:"axNodes"`
	Truncated      bool                    `json:"truncated"`
	MissingFrames  int                     `json:"missingFrameCount,omitempty"`
}

func runFixtureCommand(options directOptions, g globalOpts) int {
	if options.benchFlags {
		return reportError(g, usagef("benchmark flags apply only to dev bench-render"))
	}
	if len(options.positionals) != 3 || options.positionals[1] != commandDumpFixture {
		return reportError(g, usagef("usage: browsercontrol dev dump-fixture <url|fixture:name>"))
	}
	if options.headless || options.noSandbox || options.executable != "" {
		return reportError(g, usagef("start options apply only to browser start"))
	}
	ctx, interrupt := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer interrupt()
	ctx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()
	result, err := executeDumpFixture(ctx, options)
	if err != nil {
		return reportError(g, err)
	}
	(&session{g: g}).print(output{data: result, text: fmt.Sprintf("%s · %s · %d frames · DOM %d · AX %d · truncated %t", result.Path, result.Classification, result.Frames, result.DOMNodes, result.AXNodes, result.Truncated)})
	return 0
}

func executeDumpFixture(ctx context.Context, options directOptions) (fixtureResult, error) {
	source := options.positionals[2]
	class := devtools.Public
	request := driver.CaptureRequest{URL: source, TargetID: options.target, Private: options.allowPrivate, CaptureOptions: driver.CaptureOptions{MaxNodes: options.maxNodes, MaxFrames: options.maxFrames}}
	var synthetic *devtools.FixtureServer
	if strings.HasPrefix(source, "fixture:") {
		if options.allowPrivate || options.target != "" {
			return fixtureResult{}, usagef("synthetic fixtures do not accept --allow-private or --target")
		}
		var err error
		synthetic, err = devtools.StartFixtureServer()
		if err != nil {
			return fixtureResult{}, err
		}
		defer synthetic.Close()
		request.URL, err = synthetic.URL(strings.TrimPrefix(source, "fixture:"))
		if err != nil {
			return fixtureResult{}, usagef("%v", err)
		}
		class, request.RequireFixtureReady = devtools.Synthetic, true
	} else {
		u, err := url.Parse(source)
		if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fixtureResult{}, usagef("fixture source requires an HTTP(S) URL without userinfo, or fixture:name")
		}
		clean, err := privacy.SanitizeURL(source)
		if err != nil {
			return fixtureResult{}, usagef("invalid fixture URL")
		}
		if options.allowPrivate {
			class = devtools.Private
		} else {
			u.RawQuery = u.Query().Encode()
			if clean != u.String() || privacy.NewScrubber(nil).URL(source) != clean {
				return fixtureResult{}, usagef("credential-like URL fields/fragments require an existing page and --allow-private")
			}
		}
		if options.target != "" && !options.allowPrivate {
			return fixtureResult{}, usagef("--target requires --allow-private")
		}
	}
	worktree, err := devtools.Worktree(ctx)
	if err != nil {
		return fixtureResult{}, err
	}
	plan, err := devtools.PrepareOutput(ctx, worktree, options.out, class)
	if err != nil {
		return fixtureResult{}, usagef("%v", err)
	}
	root, err := directStoreRoot()
	if err != nil {
		return fixtureResult{}, err
	}
	store, err := sessionstore.NewStore(root, options.sessionID)
	if err != nil {
		return fixtureResult{}, err
	}
	lock, err := store.Acquire(ctx)
	if err != nil {
		return fixtureResult{}, err
	}
	defer lock.Close()
	state, err := store.Load()
	if errors.Is(err, os.ErrNotExist) {
		return fixtureResult{}, errors.New("fixture session has no browser; run browser start first")
	}
	if err != nil {
		return fixtureResult{}, err
	}
	permissions := state.EffectivePermissions()
	if err := permissions.Check(sessionstore.Read, request.URL); err != nil {
		return fixtureResult{}, err
	}
	if !options.allowPrivate {
		if err := permissions.Check(sessionstore.Act, request.URL); err != nil {
			return fixtureResult{}, err
		}
	}
	if state.Browser == nil || state.Browser.Mode != "agent" || options.profile != "" && options.profile != state.Browser.Profile {
		return fixtureResult{}, errors.New("browser_not_owned: fixture session must be bound to the selected agent profile")
	}
	manager, err := sessionstore.NewBrowserManager(root)
	if err != nil {
		return fixtureResult{}, err
	}
	claimed := ""
	defer func() {
		if claimed != "" && !request.Private {
			cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = store.ReleaseTab(cleanup, state.Browser.ID, claimed)
		}
	}()
	capture, err := manager.CaptureFixture(ctx, *state.Browser, request, func(ctx context.Context, id string) error {
		_, err := store.ClaimTab(ctx, state.Browser.ID, id, 5*time.Minute)
		if err == nil {
			claimed = id
		}
		return err
	})
	if err != nil {
		return fixtureResult{}, err
	}
	fixture := devtools.Fixture{SchemaVersion: 1, Classification: class, SourceURL: capture.URL, Observation: "snapshot_at", Snapshot: capture}
	if synthetic != nil {
		fixture.SourceURL = source
		fixture = devtools.NormalizeSynthetic(fixture, synthetic.BaseURL)
	}
	if err := ctx.Err(); err != nil {
		return fixtureResult{}, err
	}
	if err := plan.Write(fixture); err != nil {
		return fixtureResult{}, err
	}
	result := fixtureResult{Path: plan.Path, Classification: class, Frames: len(capture.Frames), Truncated: capture.Truncated, MissingFrames: len(capture.MissingFrames)}
	for _, document := range capture.Documents {
		result.DOMNodes += len(document.Nodes)
	}
	for _, tree := range capture.Accessibility {
		result.AXNodes += len(tree.Nodes)
	}
	return result, nil
}

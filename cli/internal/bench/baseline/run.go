package baseline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/bench"
	"github.com/tiktoken-go/tokenizer/codec"
)

func Run(ctx context.Context, c Config, progress io.Writer) error {
	if c.Runs < 10 || c.Runs > 100 || c.CommandsPerSample < 1 || c.CommandsPerSample > 100 || c.IdleWindow < time.Second || c.IdleWindow > time.Minute || c.Port < 1024 || c.Port > 65535 || c.Port == 8765 {
		return errors.New("invalid baseline sampling config; requires >=10 runs, >=1s idle, and a separate bridge port")
	}
	for _, path := range []*string{&c.Root, &c.Chrome, &c.Source, &c.Bridge, &c.Extension, &c.Archive, &c.Output} {
		if *path == "" {
			return errors.New("all baseline input and output paths are required")
		}
		absolute, err := filepath.Abs(*path)
		if err != nil {
			return err
		}
		*path = absolute
	}
	if _, err := os.Lstat(c.Output); !os.IsNotExist(err) {
		return errors.New("baseline report destination already exists or is unreadable")
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", c.Port))
	if err != nil {
		return errors.New("benchmark bridge port is occupied; existing services were not touched")
	}
	_ = listener.Close()
	meta, err := provenance(ctx, c)
	if err != nil {
		return err
	}
	clock, err := bench.NewClock()
	if err != nil {
		return err
	}
	server, fixtureHash := fixtureServer()
	defer server.Close()
	runParent := filepath.Join(c.Root, "data", "r0-05")
	if err := os.MkdirAll(runParent, 0700); err != nil {
		return err
	}
	runDir, err := os.MkdirTemp(runParent, "run-")
	if err != nil {
		return err
	}
	// Profiles are kept under ignored data for inspection; the harness never recursively deletes browser data.
	fmt.Fprintln(progress, "Owned run directory:", runDir)
	report := Report{SchemaVersion: 1, Task: "R0-05", BaselineCommit: SourceCommit, CollectedAt: time.Now().UTC().Format(time.RFC3339), Provenance: meta,
		Method: map[string]any{
			"processCountScope": "owned archived bridge daemon; transient snapshot children have exited; benchmark runner and one monitoring browser socket are separate test infrastructure",
			"cpuCounterCaveat":  "CDP cpuTime and Windows GetProcessTimes are independent counters and disagree materially on this host for short bursts; raw counters/cycles are retained. PID verification does not claim agreement or establish an overhead improvement.",
			"scenarioIsolation": "fresh Chrome for Testing profile per scenario; ten repeated windows in the same page; no navigating during sampling",
			"fixture":           "static synthetic inventory / 100 rows / 101 controls / no page script or external assets", "fixtureHtmlSha256": fixtureHash,
			"rendererMapping": "setup-only Chrome trace main frame URL+frame -> processId; OS executable, parent PID and creation time cross-check; SystemInfo renderer membership checked before/after",
			"instrumentation": "one root browser WebSocket; setup tracing stopped and page CDP session detached before sampling; two SystemInfo.getProcessInfo calls per interval plus before/after inventory/attachment checks outside interval",
			"cpuUnits":        "SystemInfo cumulative process cpuTime seconds; percent is delta / wall window * 100 of one logical core; no overhead subtraction",
			"osCpuUnits":      "GetProcessTimes raw 100ns kernel/user counters; bracketing window reported separately",
			"clock":           clock.Name(), "clockFrequency": clock.Frequency(), "runsPerScenario": c.Runs, "warmupSnapshots": 3, "idleWindowNs": c.IdleWindow.Nanoseconds(), "commandsPerQuerySample": c.CommandsPerSample,
			"commandLatencyScope": "before host process launch to successful process wait after stdout pipe drained; includes launch/IPC/render/pipe; not first-response/connect decomposition",
			"outputCounting":      "exact text stdout with newline; hash and ordinary-text BPE counted after CPU interval; no raw page output persisted",
			"idleScope":           "warm attached bridge idle after snapshot; <=3 minute debugger lease; no 10-minute cold-idle claim",
			"statistics":          "nearest-rank p50/p95; sequential fixed scenario order; no significance or optimization claim",
		}, Unavailable: map[string]string{
			"injectedPageCoreIdle":      "original commit has no page core; bridge-idle is the available original-engine counterpart, not an injected page-core result",
			"pageCoreMemory":            "no original isolated page core to measure; worker heap is not a substitute",
			"productionDirectCommands":  "new direct snapshot/query runtime is not migrated; archived bridge is measured here",
			"connectLatency":            "separate R0-S4 connect-spike-windows.json is a current harness probe; not an original bridge first-CDP-response measurement",
			"cdpCallsPerCommand":        "original extension has no per-method counter; no inferred counts or runtime shim used in this baseline",
			"coldIdleObserversAndCache": "10-minute detach/observer/cache behavior not measured in these warm-idle windows",
			"resumeAndCheckpoints":      "production fast/slow resume and checkpoint store do not exist at original commit",
			"successfulTaskTokens":      "query output BPE is not total tokens per successful agent task; R4-12 task suite remains required",
			"recoveryAndConformance":    "R0-08/R5-17 fault matrix and R6-07 Flow conformance are separate acceptance suites",
			"hostedCI":                  "local Windows run; R0-06 Linux hosted CI dependency is still unverified",
		}}
	counter := codec.NewO200kBase()
	for _, name := range []string{"chrome-only", "bridge-idle", "bridge-query"} {
		fmt.Fprintln(progress, "Starting", name)
		scenario, version, err := collectScenario(ctx, c, runDir, server.URL+"/baseline", name, clock, counter, progress)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		meta["chromeVersion"] = version
		meta["chromeDownloadUrl"] = "https://storage.googleapis.com/chrome-for-testing-public/" + strings.TrimPrefix(version, "Chrome/") + "/win64/chrome-win64.zip"
		report.Scenarios = append(report.Scenarios, scenario)
	}
	if err := Validate(report); err != nil {
		return err
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.Output), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(c.Output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(data, '\n'))
	closeErr := file.Close()
	return errors.Join(writeErr, closeErr)
}

func collectScenario(ctx context.Context, c Config, runDir, pageURL, name string, clock bench.Clock, counter *codec.Codec, progress io.Writer) (Scenario, string, error) {
	browser, err := launch(ctx, c, runDir, pageURL, name != "chrome-only")
	if err != nil {
		return Scenario{}, "", err
	}
	defer browser.close()
	version, err := browser.probe.Version(ctx)
	if err != nil {
		return Scenario{}, "", err
	}
	var host *bridge
	tab := 0
	if name != "chrome-only" {
		id, err := browser.extensionID(ctx, c.Extension, true)
		if err != nil {
			return Scenario{}, "", err
		}
		home, err := os.MkdirTemp(runDir, "bridge-home-")
		if err != nil {
			return Scenario{}, "", err
		}
		host, err = startBridge(ctx, c, home, id)
		if err != nil {
			return Scenario{}, "", err
		}
		defer host.close()
		tab, err = host.tab(ctx, pageURL)
		if err != nil {
			return Scenario{}, "", err
		}
		for i := 0; i < 3; i++ {
			if _, err := host.snapshot(ctx, tab); err != nil {
				return Scenario{}, "", err
			}
		}
	}
	select {
	case <-ctx.Done():
		return Scenario{}, "", ctx.Err()
	case <-time.After(time.Second):
	}
	if host == nil {
		if _, err := browser.extensionID(ctx, c.Extension, false); err != nil {
			return Scenario{}, "", err
		}
	}
	scenario := Scenario{Name: name, ExtensionWorkers: browser.workerNames}
	for i := 0; i < c.Runs; i++ {
		sample, outputs, err := collectSample(ctx, c, browser, host, tab, pageURL, name, clock)
		if err != nil {
			return Scenario{}, "", err
		}
		sample.Index = i + 1
		for j, output := range outputs {
			tokens, err := counter.Count(string(output))
			if err != nil {
				return Scenario{}, "", err
			}
			sample.Commands[j].StdoutBytes, sample.Commands[j].StdoutTokens, sample.Commands[j].StdoutSHA256 = len(output), tokens, hash(output)
		}
		scenario.Samples = append(scenario.Samples, sample)
		fmt.Fprintf(progress, "%s %d/%d: renderer %.3f%%, %d commands\n", name, i+1, c.Runs, sample.RendererPercent, len(sample.Commands))
	}
	scenario.Summary = summarize(scenario.Samples)
	return scenario, version, nil
}

func collectSample(ctx context.Context, c Config, b *browser, host *bridge, tab int, pageURL, name string, clock bench.Clock) (Sample, [][]byte, error) {
	sample := Sample{RendererPID: b.page.RendererPID, BrowserPID: b.pid}
	if host != nil {
		sample.BridgePID, sample.HostProcesses = host.command.Process.Pid, 1
	}
	checkPage := func() error {
		targets, err := b.probe.Targets(ctx)
		if err != nil {
			return err
		}
		count, match := 0, false
		for _, target := range targets {
			if target.Type == "page" {
				count++
				match = target.ID == b.page.TargetID && target.URL == pageURL
			}
		}
		if count != 1 || !match {
			return errors.New("sample no longer contains exactly one identified fixture page")
		}
		sample.PageCount = count
		return nil
	}
	if err := checkPage(); err != nil {
		return Sample{}, nil, err
	}
	var err error
	sample.PageAttachedBefore, err = b.probe.PageAttached(ctx, b.page.TargetID)
	if err != nil || sample.PageAttachedBefore != (host != nil) {
		return Sample{}, nil, errors.New("unexpected before-sample page debugger attachment state")
	}
	osStart := clock.Now()
	sample.RendererBefore, err = readProcess(sample.RendererPID, c.Chrome)
	if err != nil {
		return Sample{}, nil, err
	}
	if host != nil {
		reading, err := readProcess(sample.BridgePID, c.Bridge)
		if err != nil {
			return Sample{}, nil, err
		}
		sample.BridgeBefore = &reading
	}
	sample.RendererCDPBefore, err = rendererCPU(ctx, b)
	if err != nil {
		return Sample{}, nil, err
	}
	start := clock.Now()
	var outputs [][]byte
	if name == "bridge-query" {
		for i := 0; i < c.CommandsPerSample; i++ {
			commandStart := clock.Now()
			output, err := host.snapshot(ctx, tab)
			elapsed := clock.Elapsed(commandStart, clock.Now())
			if err != nil {
				return Sample{}, nil, err
			}
			sample.Commands = append(sample.Commands, Command{DurationNS: elapsed})
			outputs = append(outputs, output)
		}
	} else {
		select {
		case <-ctx.Done():
			return Sample{}, nil, ctx.Err()
		case <-time.After(c.IdleWindow):
		}
	}
	sample.RendererCDPAfter, err = rendererCPU(ctx, b)
	sample.WallNS = clock.Elapsed(start, clock.Now())
	if err != nil {
		return Sample{}, nil, err
	}
	if host != nil {
		reading, err := readProcess(sample.BridgePID, c.Bridge)
		if err != nil {
			return Sample{}, nil, err
		}
		sample.BridgeAfter = &reading
		if err := validatePair(*sample.BridgeBefore, reading); err != nil {
			return Sample{}, nil, err
		}
	}
	sample.RendererAfter, err = readProcess(sample.RendererPID, c.Chrome)
	sample.OSWindowNS = clock.Elapsed(osStart, clock.Now())
	if err != nil {
		return Sample{}, nil, err
	}
	if err := validatePair(sample.RendererBefore, sample.RendererAfter); err != nil {
		return Sample{}, nil, err
	}
	if sample.RendererBefore.ParentPID != b.pid {
		return Sample{}, nil, errors.New("renderer parent no longer matches owned browser")
	}
	sample.RendererCDPDelta = sample.RendererCDPAfter - sample.RendererCDPBefore
	if sample.RendererCDPDelta < 0 || sample.WallNS <= 0 {
		return Sample{}, nil, errors.New("invalid renderer CPU counters or sample window")
	}
	sample.RendererPercent = sample.RendererCDPDelta / (float64(sample.WallNS) / 1e9) * 100
	if err := checkPage(); err != nil {
		return Sample{}, nil, err
	}
	sample.PageAttachedAfter, err = b.probe.PageAttached(ctx, b.page.TargetID)
	if err != nil || sample.PageAttachedAfter != sample.PageAttachedBefore {
		return Sample{}, nil, errors.New("page debugger attachment changed during sample")
	}
	sample.PIDVerified = true
	return sample, outputs, nil
}

func rendererCPU(ctx context.Context, b *browser) (float64, error) {
	processes, err := b.probe.Processes(ctx)
	if err != nil {
		return 0, err
	}
	for _, process := range processes {
		if process.ID == b.page.RendererPID && process.Type == "renderer" {
			return process.CPUTime, nil
		}
	}
	return 0, errors.New("identified renderer is absent from Chrome process inventory")
}

func validatePair(before, after ProcessReading) error {
	if before.Start == "" || before.Start != after.Start || !before.ImageVerified || !after.ImageVerified || before.ParentPID != after.ParentPID || after.Kernel100NS < before.Kernel100NS || after.User100NS < before.User100NS || before.Cycles == 0 || after.Cycles < before.Cycles {
		return errors.New("OS process identity/counter continuity failed")
	}
	return nil
}

func quantiles(values []float64) Quantile {
	slices.Sort(values)
	return Quantile{Count: len(values), Min: values[0], P50: values[int(math.Ceil(float64(len(values))*.5))-1], P95: values[int(math.Ceil(float64(len(values))*.95))-1], Max: values[len(values)-1]}
}

func summarize(samples []Sample) map[string]Quantile {
	values := map[string][]float64{}
	for _, sample := range samples {
		values["rendererPercentOfOneCore"] = append(values["rendererPercentOfOneCore"], sample.RendererPercent)
		values["rendererCdpCpuSecondsDelta"] = append(values["rendererCdpCpuSecondsDelta"], sample.RendererCDPDelta)
		osDelta := sample.RendererAfter.Kernel100NS - sample.RendererBefore.Kernel100NS + sample.RendererAfter.User100NS - sample.RendererBefore.User100NS
		values["rendererOsCpuSecondsDelta"] = append(values["rendererOsCpuSecondsDelta"], float64(osDelta)/1e7)
		values["rendererOsCyclesDelta"] = append(values["rendererOsCyclesDelta"], float64(sample.RendererAfter.Cycles-sample.RendererBefore.Cycles))
		if sample.BridgeBefore != nil {
			before, after := sample.BridgeBefore, sample.BridgeAfter
			delta := after.Kernel100NS - before.Kernel100NS + after.User100NS - before.User100NS
			values["bridgeOsCpuSecondsDelta"] = append(values["bridgeOsCpuSecondsDelta"], float64(delta)/1e7)
			values["bridgeOsCyclesDelta"] = append(values["bridgeOsCyclesDelta"], float64(after.Cycles-before.Cycles))
		}
		for _, command := range sample.Commands {
			values["commandLatencyNs"] = append(values["commandLatencyNs"], float64(command.DurationNS))
			values["stdoutBytes"] = append(values["stdoutBytes"], float64(command.StdoutBytes))
			values["stdoutTokens"] = append(values["stdoutTokens"], float64(command.StdoutTokens))
		}
	}
	result := map[string]Quantile{}
	for name, samples := range values {
		result[name] = quantiles(samples)
	}
	return result
}

func Validate(report Report) error {
	if report.SchemaVersion != 1 || report.Task != "R0-05" || report.BaselineCommit != SourceCommit || len(report.Scenarios) != 3 {
		return errors.New("baseline schema/source/scenario count is invalid")
	}
	for _, key := range []string{"archiveSha256", "originalInputsSha256", "bridgeExecutableSha256", "extensionTreeSha256", "chromeExecutableSha256", "chromeArchiveSha256", "harnessExecutableSha256", "harnessGoInputsSha256"} {
		value, _ := report.Provenance[key].(string)
		if len(value) != 64 || strings.Trim(value, "0123456789abcdef") != "" {
			return errors.New("baseline provenance hash is missing or invalid")
		}
	}
	for _, key := range []string{"injectedPageCoreIdle", "pageCoreMemory", "connectLatency", "cdpCallsPerCommand", "successfulTaskTokens", "hostedCI"} {
		if report.Unavailable[key] == "" {
			return errors.New("baseline must disclose unavailable KPI scope")
		}
	}
	configInt := func(key string) int {
		switch value := report.Method[key].(type) {
		case int:
			return value
		case float64:
			if value == math.Trunc(value) {
				return int(value)
			}
		}
		return 0
	}
	runs, commands := configInt("runsPerScenario"), configInt("commandsPerQuerySample")
	if runs < 10 || commands < 1 {
		return errors.New("baseline sampling configuration is invalid")
	}
	for i, name := range []string{"chrome-only", "bridge-idle", "bridge-query"} {
		scenario := report.Scenarios[i]
		if scenario.Name != name || len(scenario.Samples) != runs {
			return errors.New("baseline requires >=10 samples in every declared scenario")
		}
		for index, sample := range scenario.Samples {
			if sample.Index != index+1 || sample.RendererCDPBefore < 0 || sample.RendererCDPDelta != sample.RendererCDPAfter-sample.RendererCDPBefore || math.Abs(sample.RendererPercent-sample.RendererCDPDelta/float64(sample.WallNS)*1e11) > 1e-8 {
				return errors.New("baseline sample index or derived CPU value is inconsistent")
			}
			if sample.PageCount != 1 || !sample.PIDVerified || sample.RendererPID <= 0 || sample.BrowserPID <= 0 || sample.RendererBefore.ParentPID != sample.BrowserPID || sample.WallNS <= 0 || sample.OSWindowNS < sample.WallNS || sample.RendererCDPAfter < sample.RendererCDPBefore || sample.RendererCDPDelta < 0 || math.IsNaN(sample.RendererPercent) || math.IsInf(sample.RendererPercent, 0) {
				return errors.New("baseline CPU sample failed identity/window/counter validation")
			}
			if err := validatePair(sample.RendererBefore, sample.RendererAfter); err != nil {
				return err
			}
			if name == "chrome-only" {
				if sample.HostProcesses != 0 || sample.BridgePID != 0 || sample.PageAttachedBefore || sample.PageAttachedAfter || len(sample.Commands) != 0 {
					return errors.New("Chrome-only sample contains BrowserControl runtime")
				}
			} else {
				if sample.HostProcesses != 1 || sample.BridgePID <= 0 || !sample.PageAttachedBefore || !sample.PageAttachedAfter || sample.BridgeBefore == nil || sample.BridgeAfter == nil {
					return errors.New("bridge sample is missing daemon/attachment evidence")
				}
				if err := validatePair(*sample.BridgeBefore, *sample.BridgeAfter); err != nil {
					return err
				}
			}
			if name == "bridge-query" && len(sample.Commands) != commands || name != "bridge-query" && len(sample.Commands) != 0 {
				return errors.New("sample command count does not match scenario")
			}
			for _, command := range sample.Commands {
				if command.ExitCode != 0 || command.DurationNS <= 0 || command.StdoutBytes <= 0 || command.StdoutTokens <= 0 || len(command.StdoutSHA256) != 64 || strings.Trim(command.StdoutSHA256, "0123456789abcdef") != "" {
					return errors.New("baseline snapshot command evidence is invalid")
				}
			}
		}
		if !reflect.DeepEqual(scenario.Summary, summarize(scenario.Samples)) {
			return errors.New("baseline summary does not match raw samples")
		}
	}
	return nil
}

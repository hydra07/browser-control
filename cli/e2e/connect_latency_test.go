package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

const connectProbeEnv = "BROWSERCONTROL_CONNECT_PROBE"

type connectSample struct {
	Mode                string             `json:"mode"`
	Milliseconds        map[string]float64 `json:"milliseconds"`
	CDPCalls            uint64             `json:"cdpCalls"`
	HeavyDomainsEnabled int                `json:"heavyDomainsEnabled"`
}

func TestConnectLatencyDistribution(t *testing.T) {
	got := latencyDistribution([]float64{10, 2, 3, 7, 5, 8, 1, 4, 6, 9})
	if got["p50"] != 5 || got["p95"] != 10 || got["count"] != 10 {
		t.Fatalf("unexpected nearest-rank distribution: %+v", got)
	}
}

func TestChromeConnectLatencySpike(t *testing.T) {
	if os.Getenv("BROWSERCONTROL_E2E_BENCH") != "1" {
		t.Skip("opt-in latency measurement; set BROWSERCONTROL_E2E_BENCH=1")
	}
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	_ = h.client.ws.Close()
	var samples []connectSample
	for i := 0; i < 10; i++ {
		for _, mode := range []string{"cold-discovery", "warm-target"} {
			sample := runConnectProbe(t, h, p.targetID, mode)
			if sample.CDPCalls < 5 || sample.HeavyDomainsEnabled != 0 {
				t.Fatalf("invalid probe calls: %+v", sample)
			}
			samples = append(samples, sample)
		}
	}
	summary := map[string]map[string]map[string]float64{}
	for _, mode := range []string{"cold-discovery", "warm-target"} {
		summary[mode] = map[string]map[string]float64{}
		for stage := range samples[0].Milliseconds {
			var values []float64
			for _, sample := range samples {
				if sample.Mode == mode {
					values = append(values, sample.Milliseconds[stage])
				}
			}
			summary[mode][stage] = latencyDistribution(values)
		}
	}
	report := map[string]any{
		"schemaVersion": 1, "spike": "R0-S4", "chrome": h.version,
		"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH,
		"logicalCPUs": runtime.NumCPU(), "samples": samples, "summary": summary,
		"scope":       "fresh Go test-binary processes, owned headless agent profile, cached OS/browser; cold means no target cache, not OS cold boot",
		"limitations": []string{"startup includes Go test harness", "tiny sentinel handshake, not production pagecore", "no bridge comparison or user-profile consent", "observed latency, not a performance budget"},
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if path := os.Getenv("BROWSERCONTROL_E2E_BENCH_OUT"); path != "" {
		if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Log(string(data))
}

func runConnectProbe(t *testing.T, h *chromeHarness, targetID, mode string) connectSample {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now().UnixNano()
	input, err := json.Marshal(map[string]any{"profile": h.profile, "targetId": targetID, "url": h.server.URL + "/controls.html", "mode": mode, "started": started})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(h.ctx, executable, "-test.run=^TestConnectProbeClient$", "-test.timeout=10s")
	command.Env = append(os.Environ(), connectProbeEnv+"="+string(input))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("connect probe: %v\n%s", err, output)
	}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if data, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("CONNECT_PROBE=")); ok {
			var sample connectSample
			if err := json.Unmarshal(data, &sample); err != nil {
				t.Fatal(err)
			}
			return sample
		}
	}
	t.Fatalf("missing probe output: %s", output)
	return connectSample{}
}

func TestConnectProbeClient(t *testing.T) {
	entered := time.Now()
	input := os.Getenv(connectProbeEnv)
	if input == "" {
		t.Skip("subprocess helper")
	}
	var config struct {
		Profile, TargetID, URL, Mode string
		Started                      int64
	}
	if err := json.Unmarshal([]byte(input), &config); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	sample := connectSample{Mode: config.Mode, Milliseconds: map[string]float64{}}
	sample.Milliseconds["processStartupAndTestHarness"] = float64(entered.UnixNano()-config.Started) / 1e6
	start := time.Now()
	endpoint, err := readProbeEndpoint(config.Profile)
	if err != nil {
		t.Fatal(err)
	}
	sample.Milliseconds["endpointRead"] = float64(time.Since(start)) / 1e6
	start = time.Now()
	client, err := dialTestConnection(ctx, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer client.ws.Close()
	sample.Milliseconds["websocketConnect"] = float64(time.Since(start)) / 1e6
	if err := client.call(ctx, "", "Browser.getVersion", nil, nil); err != nil {
		t.Fatal(err)
	}
	sample.Milliseconds["processToFirstCDPResponse"] = float64(time.Now().UnixNano()-config.Started) / 1e6
	start = time.Now()
	if config.Mode == "cold-discovery" {
		var targets struct {
			TargetInfos []struct{ TargetID, URL, Type string }
		}
		if err := client.call(ctx, "", "Target.getTargets", nil, &targets); err != nil {
			t.Fatal(err)
		}
		config.TargetID = ""
		for _, target := range targets.TargetInfos {
			if target.Type == "page" && target.URL == config.URL {
				if config.TargetID != "" {
					t.Fatal("ambiguous fixture target")
				}
				config.TargetID = target.TargetID
			}
		}
	}
	if config.TargetID == "" {
		t.Fatal("missing fixture target")
	}
	sample.Milliseconds["targetDiscovery"] = float64(time.Since(start)) / 1e6
	start = time.Now()
	var attached struct{ SessionID string }
	if err := client.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": config.TargetID, "flatten": true}, &attached); err != nil {
		t.Fatal(err)
	}
	sample.Milliseconds["attach"] = float64(time.Since(start)) / 1e6
	start = time.Now()
	h := &chromeHarness{ctx: ctx, client: client}
	p := &testPage{h: h, client: client, targetID: config.TargetID, session: attached.SessionID}
	world := p.isolatedWorld(t)
	var handshake struct{ Version int }
	p.evalIn(t, world, `(() => { const c = globalThis.__bcConnectProbe ??= {version: 1}; return {version: c.version}; })()`, &handshake)
	if handshake.Version != 1 {
		t.Fatal("handshake probe failed")
	}
	sample.Milliseconds["sentinelHandshake"] = float64(time.Since(start)) / 1e6
	sample.Milliseconds["processToHandshake"] = float64(time.Now().UnixNano()-config.Started) / 1e6
	sample.CDPCalls = client.id
	data, err := json.Marshal(sample)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("CONNECT_PROBE=" + string(data))
}

func readProbeEndpoint(profile string) (string, error) {
	data, err := os.ReadFile(filepath.Join(profile, "DevToolsActivePort"))
	if err != nil {
		return "", err
	}
	lines := strings.Fields(string(data))
	if len(lines) != 2 {
		return "", fmt.Errorf("invalid DevToolsActivePort")
	}
	port, err := strconv.Atoi(lines[0])
	if err != nil || port < 1 || port > 65535 || !strings.HasPrefix(lines[1], "/devtools/browser/") {
		return "", fmt.Errorf("invalid DevToolsActivePort endpoint")
	}
	return "ws://" + net.JoinHostPort("127.0.0.1", lines[0]) + lines[1], nil
}

func latencyDistribution(values []float64) map[string]float64 {
	values = slices.Clone(values)
	slices.Sort(values)
	return map[string]float64{"count": float64(len(values)), "p50": values[(len(values)-1)/2], "p95": values[(95*len(values)+99)/100-1]}
}

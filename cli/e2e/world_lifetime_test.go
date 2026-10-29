package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const (
	probeInitialize = "initialize"
	probeInspect    = "inspect"
	probeModeEnv    = "BROWSERCONTROL_E2E_PROBE_MODE"
	probeURLEnv     = "BROWSERCONTROL_E2E_PROBE_ENDPOINT"
	probeTargetEnv  = "BROWSERCONTROL_E2E_PROBE_TARGET"
	probePrefix     = "BROWSERCONTROL_WORLD_PROBE="
)

type worldProbeResult struct {
	SameDocument bool   `json:"sameDocument"`
	CorePresent  bool   `json:"corePresent"`
	Ref          string `json:"ref"`
}

func TestChromeIsolatedWorldAcrossProcesses(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	_ = h.client.ws.Close()
	writer := runWorldProbeClient(t, h, p.targetID, probeInitialize)
	if !writer.SameDocument || !writer.CorePresent || writer.Ref != "e1" {
		t.Fatalf("the first client did not initialize the probe: %+v", writer)
	}
	reader := runWorldProbeClient(t, h, p.targetID, probeInspect)
	if !reader.SameDocument {
		t.Fatal("the document did not survive the two client processes")
	}
	h.reconnect(t)
	h.waitDetached(t, p.targetID)
	p = h.attach(t, p.targetID)
	var sameDocument bool
	p.eval(t, `globalThis.__bcE2EProcessMain === "same-document"`, &sameDocument)
	if !sameDocument {
		t.Fatal("the independent clients replaced the fixture document")
	}
	report, err := json.Marshal(map[string]any{
		"spike": "R0-S1", "chrome": h.version, "clientProcesses": 2,
		"sameDocument": reader.SameDocument, "isolatedWorldRediscovered": reader.CorePresent,
		"weakMapIdentitySurvived": reader.Ref == "e1", "targetDetachedBetweenClients": true,
		"scope": "headless temporary agent profile; no production page core or user-profile consent",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(report))
}

func runWorldProbeClient(t *testing.T, h *chromeHarness, targetID, mode string) worldProbeResult {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(h.ctx, executable, "-test.run=^TestWorldProbeClient$", "-test.timeout=15s")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key != probeModeEnv && key != probeURLEnv && key != probeTargetEnv {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, probeModeEnv+"="+mode, probeURLEnv+"="+h.endpoint, probeTargetEnv+"="+targetID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s client process: %v\n%s", mode, err, output)
	}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if data, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte(probePrefix)); ok {
			var result worldProbeResult
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
			return result
		}
	}
	t.Fatalf("%s client returned no probe result: %s", mode, output)
	return worldProbeResult{}
}

func TestWorldProbeClient(t *testing.T) {
	mode := os.Getenv(probeModeEnv)
	if mode == "" {
		t.Skip("subprocess entry point for the isolated-world lifetime spike")
	}
	endpoint, err := url.Parse(os.Getenv(probeURLEnv))
	if err != nil || endpoint.Scheme != "ws" || !net.ParseIP(endpoint.Hostname()).IsLoopback() ||
		!strings.HasPrefix(endpoint.Path, "/devtools/browser/") {
		t.Fatal("the probe requires its parent's loopback Chrome endpoint")
	}
	targetID := os.Getenv(probeTargetEnv)
	if targetID == "" {
		t.Fatal("the probe requires its parent's fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := dialTestConnection(ctx, endpoint.String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.ws.Close()
	h := &chromeHarness{ctx: ctx, endpoint: endpoint.String(), client: client}
	h.waitDetached(t, targetID)
	p := h.attach(t, targetID)
	world := p.isolatedWorld(t)
	if mode == probeInitialize {
		p.eval(t, `globalThis.__bcE2EProcessMain = "same-document"`, nil)
		p.evalIn(t, world, `(() => {
			globalThis.__bcE2EProcessCore = {
				version: 1,
				refs: new WeakMap([[document.querySelector("button"), "e1"]])
			};
			return true;
		})()`, nil)
	} else if mode != probeInspect {
		t.Fatalf("unsupported probe mode %q", mode)
	}
	var result worldProbeResult
	p.eval(t, `globalThis.__bcE2EProcessMain === "same-document"`, &result.SameDocument)
	p.evalIn(t, world, `(() => {
		const core = globalThis.__bcE2EProcessCore;
		return { corePresent: core?.version === 1, ref: core?.refs.get(document.querySelector("button")) ?? "" };
	})()`, &result)
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(probePrefix + string(data))
}

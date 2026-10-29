package bench_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/bench/baseline"
)

func baselineEvidence(t *testing.T) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "bench", "baseline-9a1b4c6.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("R0-05 baseline evidence missing: %v", err)
	}
	return data
}

func TestVersionedBaselineHasCPUAndBridgeEvidence(t *testing.T) {
	var report baseline.Report
	if err := json.Unmarshal(baselineEvidence(t), &report); err != nil {
		t.Fatal(err)
	}
	if err := baseline.Validate(report); err != nil {
		t.Fatal(err)
	}
}

func TestBaselineRejectsBrokenEvidence(t *testing.T) {
	data := baselineEvidence(t)
	mutations := map[string]func(*baseline.Report){
		"missing provenance":            func(r *baseline.Report) { delete(r.Provenance, "archiveSha256") },
		"hidden unavailable KPI":        func(r *baseline.Report) { delete(r.Unavailable, "successfulTaskTokens") },
		"wrong derived cpu":             func(r *baseline.Report) { r.Scenarios[0].Samples[0].RendererPercent++ },
		"stale summary":                 func(r *baseline.Report) { delete(r.Scenarios[0].Summary, "rendererPercentOfOneCore") },
		"wrong source":                  func(r *baseline.Report) { r.BaselineCommit = "dirty-worktree" },
		"insufficient repeats":          func(r *baseline.Report) { r.Scenarios[0].Samples = r.Scenarios[0].Samples[:9] },
		"multiple pages":                func(r *baseline.Report) { r.Scenarios[0].Samples[0].PageCount = 2 },
		"unverified pid":                func(r *baseline.Report) { r.Scenarios[0].Samples[0].PIDVerified = false },
		"wrong renderer parent":         func(r *baseline.Report) { r.Scenarios[0].Samples[0].RendererBefore.ParentPID++ },
		"recycled pid":                  func(r *baseline.Report) { r.Scenarios[0].Samples[0].RendererAfter.Start = "recycled" },
		"wrong executable":              func(r *baseline.Report) { r.Scenarios[0].Samples[0].RendererAfter.ImageVerified = false },
		"decreasing cpu":                func(r *baseline.Report) { r.Scenarios[0].Samples[0].RendererCDPAfter = -1 },
		"bad window":                    func(r *baseline.Report) { r.Scenarios[0].Samples[0].WallNS = 0 },
		"hidden chrome-only attachment": func(r *baseline.Report) { r.Scenarios[0].Samples[0].PageAttachedAfter = true },
		"missing daemon":                func(r *baseline.Report) { r.Scenarios[1].Samples[0].HostProcesses = 0 },
		"bridge detached":               func(r *baseline.Report) { r.Scenarios[1].Samples[0].PageAttachedAfter = false },
		"missing query":                 func(r *baseline.Report) { r.Scenarios[2].Samples[0].Commands = nil },
		"failed query":                  func(r *baseline.Report) { r.Scenarios[2].Samples[0].Commands[0].ExitCode = 1 },
		"empty output":                  func(r *baseline.Report) { r.Scenarios[2].Samples[0].Commands[0].StdoutBytes = 0 },
		"bad output hash":               func(r *baseline.Report) { r.Scenarios[2].Samples[0].Commands[0].StdoutSHA256 = "bad" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			var report baseline.Report
			if err := json.Unmarshal(data, &report); err != nil {
				t.Fatal(err)
			}
			mutate(&report)
			if err := baseline.Validate(report); err == nil {
				t.Fatal("invalid evidence accepted")
			}
		})
	}
}

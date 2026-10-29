package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func benchFixture(t *testing.T) string {
	t.Helper()
	fixture := devtools.Fixture{
		SchemaVersion: 1, Classification: devtools.Synthetic, SourceURL: "fixture:bench", Observation: "snapshot_at",
		Snapshot: driver.Capture{Epoch: "fixture_bench", URL: "http://fixture.test/", Browser: "offline",
			Frames: []driver.Frame{{ID: "main", URL: "http://fixture.test/"}},
			Accessibility: []driver.AccessTree{{FrameID: "main", Nodes: []driver.AccessNode{
				{ID: "root", Handle: 1, Role: "RootWebArea", Children: []string{"heading", "first", "second", "save"}},
				{ID: "heading", Handle: 10, Role: "heading", Name: "Checkout", Children: []string{"label"}},
				{ID: "label", Handle: 11, Role: "StaticText", Name: "Checkout"},
				{ID: "first", Handle: 20, Role: "StaticText", Name: "Terms"},
				{ID: "second", Handle: 22, Role: "StaticText", Name: "apply"},
				{ID: "save", Handle: 30, Role: "button", Name: `Save <draft> & "send"`},
			}}},
		},
	}
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "render.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBenchRenderOfflineMetricsMatchExactOutput(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	path := benchFixture(t)
	var previous map[string]any
	for range 2 {
		code, stdout, stderr := runCLIProcess(t, "dev", "bench-render", path, "--runs", "10", "--warmup", "0", "--json")
		if code != 0 || stderr != "" {
			t.Fatalf("offline benchmark: %d %s %s", code, stdout, stderr)
		}
		report := singleJSONResult(t, stdout)
		if report["schemaVersion"] != float64(1) || report["renderer"] != "legacy-flat-cli-v1" {
			t.Fatalf("missing benchmark identity: %+v", report)
		}
		cases := report["cases"].([]any)
		if len(cases) != 1 {
			t.Fatalf("expected one frame case, got %d", len(cases))
		}
		result := cases[0].(map[string]any)
		if result["projectedNodes"] != float64(3) || result["shownNodes"] != float64(3) {
			t.Fatalf("incorrect projection/coverage counts: %+v", result)
		}
		agent := result["agent"].(map[string]any)
		expected := "[10] heading \"Checkout\"\n[20] StaticText \"Terms apply\"\n[30] button \"Save <draft> & \\\"send\\\"\"\n"
		hash := sha256.Sum256([]byte(expected))
		if agent["bytes"] != float64(len(expected)) || agent["sha256"] != hex.EncodeToString(hash[:]) || agent["tokens"].(float64) <= 0 {
			t.Fatalf("metrics do not describe exact stdout including newline: %+v", agent)
		}
		if strings.Contains(stdout, "Checkout") || strings.Contains(stdout, "fixture_bench") {
			t.Fatal("benchmark report leaked page text or runtime handles")
		}
		delete(result, "timings")
		if previous != nil && !reflect.DeepEqual(previous, result) {
			t.Fatal("non-timing metrics changed for identical fixture/config")
		}
		previous = result
	}
}

func TestBenchRenderFlagsStayScopedAndHelpIsOffline(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	code, stdout, stderr := runCLIProcess(t, "dev", "bench-render", "--help", "--json")
	if code != 0 || !strings.Contains(singleJSONResult(t, stdout)["help"].(string), "--encoding") {
		t.Fatalf("benchmark help: %d %s %s", code, stdout, stderr)
	}
	for _, args := range [][]string{
		{"dev", "bench-render", "--runs", "0"},
		{"dev", "bench-render", "--runs", "1001"},
		{"dev", "bench-render", "--warmup", "-1"},
		{"dev", "bench-render", "--encoding", "guess"},
		{"dev", "bench-render", "--limit", "-1"},
		{"dev", "bench-render", "--out", "should-not-write.json"},
		{"dev", "bench-render", "--allow-private"},
		{"browser", "status", "--runs", "10"},
		{"dev", "dump-fixture", "fixture:form", "--encoding", "o200k_base"},
	} {
		code, stdout, stderr := runCLIProcess(t, append(args, "--json")...)
		if code != 2 || singleJSONResult(t, stdout)["error"] == nil || stderr != "" {
			t.Fatalf("invalid benchmark flags: %v: %d %s %s", args, code, stdout, stderr)
		}
	}
}

func TestBenchMetricsMatchLegacyCommandWithFilteringAndJSONEscaping(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	path := benchFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeCompactJSON(w, map[string]any{"result": map[string]any{"nodes": []any{
			map[string]any{"i": 10, "r": "heading", "n": "Checkout"},
			map[string]any{"i": 20, "r": "StaticText", "n": "Terms apply"},
			map[string]any{"i": 30, "r": "button", "n": `Save <draft> & "send"`},
		}}})
	}))
	defer server.Close()
	for _, flags := range [][]string{{"--limit", "0"}, {"--limit", "1"}, {"--grep", "Save"}, {"--grep", "unmatched"}} {
		args := append([]string{"dev", "bench-render", path, "--runs", "10", "--warmup", "0", "--json"}, flags...)
		code, stdout, stderr := runCLIProcess(t, args...)
		if code != 0 {
			t.Fatalf("benchmark failed: %d %s %s", code, stdout, stderr)
		}
		result := singleJSONResult(t, stdout)["cases"].([]any)[0].(map[string]any)
		for _, format := range []string{"agent", "json"} {
			args := append([]string{"extension", "snapshot", "--url", server.URL, "--token", "0123456789abcdef0123456789abcdef", "--no-autostart"}, flags...)
			if format == "json" {
				args = append(args, "--json")
			}
			code, stdout, stderr := runCLIProcess(t, args...)
			if code != 0 {
				t.Fatalf("legacy command failed: %d %s %s", code, stdout, stderr)
			}
			metrics := result[format].(map[string]any)
			hash := sha256.Sum256([]byte(stdout))
			if metrics["bytes"] != float64(len(stdout)) || metrics["sha256"] != hex.EncodeToString(hash[:]) {
				t.Fatalf("benchmark diverged from actual %s stdout with %v", format, flags)
			}
		}
	}
}

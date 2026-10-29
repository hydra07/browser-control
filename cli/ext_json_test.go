package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestJSONBatchFailureIsOneResult(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		result := map[string]any{"success": true}
		if call == 2 {
			result = map[string]any{"success": false, "reason": "assert_failed", "message": "missing text", "effect": "not_verified"}
		}
		writeCompactJSON(w, map[string]any{"result": result})
	}))
	defer server.Close()
	code, stdout, stderr := runJSONCLI(t, server.URL, "do", "click 12", "exec failing_flow", "click 14")
	if code != 1 || calls.Load() != 2 {
		t.Fatalf("code=%d calls=%d stdout=%s stderr=%s", code, calls.Load(), stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	if result["error"] == nil {
		t.Fatalf("missing error: %+v", result)
	}
	steps, ok := result["steps"].([]any)
	if !ok || len(steps) != 1 || steps[0].(map[string]any)["command"] != "click" {
		t.Fatalf("missing completed steps: %+v", result)
	}
	failed, ok := result["failedStep"].(map[string]any)
	if !ok || failed["step"] != float64(2) || failed["command"] != "exec" {
		t.Fatalf("missing failed-step identity: %+v", result)
	}
	if result["result"].(map[string]any)["effect"] != "not_verified" {
		t.Fatalf("failed command's result was lost: %+v", result)
	}
}

func TestJSONHelpAndEarlyUsageErrors(t *testing.T) {
	for _, args := range [][]string{{}, {"help"}, {"help", "click"}, {"click", "--help"}} {
		code, stdout, stderr := runJSONCLI(t, "", args...)
		if code != 0 || singleJSONResult(t, stdout)["help"] == nil {
			t.Fatalf("args=%v code=%d stdout=%s stderr=%s", args, code, stdout, stderr)
		}
	}
	// A late --json must still select the error format when parsing stops at an earlier bad flag.
	code, stdout, stderr := runCLIProcess(t, "--port", "invalid", "--json")
	if code != 2 || singleJSONResult(t, stdout)["error"] == nil || stderr != "" {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestJSONExecScreenshotAndFlow(t *testing.T) {
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	imageBase64 := base64.StdEncoding.EncodeToString(encoded.Bytes())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		result := map[string]any{"success": true, "imageBase64": imageBase64, "format": "png"}
		if request["cmd"] == "run_flow" {
			result = map[string]any{"success": false, "reason": "assert_failed", "steps": []any{map[string]any{"success": true}, map[string]any{"success": false}}}
		}
		writeCompactJSON(w, map[string]any{"result": result})
	}))
	defer server.Close()
	for _, args := range [][]string{{"exec", "raw_capture"}, {"screenshot"}} {
		code, stdout, stderr := runJSONCLI(t, server.URL, args...)
		if code != 0 {
			t.Fatalf("args=%v code=%d stdout=%s stderr=%s", args, code, stdout, stderr)
		}
		result := singleJSONResult(t, stdout)
		if strings.Contains(stdout, imageBase64) || result["imageBase64"] != nil || result["imagePath"] == nil {
			t.Fatalf("image must be an artifact path: %+v", result)
		}
	}
	flowPath := filepath.Join(t.TempDir(), "flow.json")
	if err := os.WriteFile(flowPath, []byte(`{"schemaVersion":2,"steps":[{"action":"click","selector":"#save"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := runJSONCLI(t, server.URL, "flow", "run", flowPath)
	if code != 1 {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	failed := result["result"].(map[string]any)
	if result["error"] == nil || len(failed["steps"].([]any)) != 2 {
		t.Fatalf("flow failure details were lost: %+v", result)
	}
}

func TestJSONServeBindFailureKeepsStdoutMachineReadable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	code, stdout, stderr := runJSONCLI(t, "", "serve", "--port", strconv.Itoa(port))
	if code != 1 || singleJSONResult(t, stdout)["error"] == nil {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestJSONScalarAndListResultsHaveEnvelopes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeCompactJSON(w, map[string]any{"result": map[string]any{"result": 42}})
	}))
	defer server.Close()
	code, stdout, stderr := runJSONCLI(t, server.URL, "eval", "42")
	if code != 0 || singleJSONResult(t, stdout)["result"] != float64(42) {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
	code, stdout, stderr = runJSONCLI(t, "", "flow", "list")
	if code != 0 || singleJSONResult(t, stdout)["flows"] == nil {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestJSONFirstStepUsageFailureKeepsExitCode(t *testing.T) {
	code, stdout, stderr := runJSONCLI(t, "", "do", "click", "click 14")
	if code != 2 {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	if result["error"] == nil || result["failedStep"].(map[string]any)["step"] != float64(1) || result["steps"] != nil {
		t.Fatalf("incorrect first-step failure: %+v", result)
	}
}

func TestTextBatchFailureStillShowsCompletedSteps(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true}})
	}))
	defer server.Close()
	code, stdout, stderr := runCLIProcess(t, "--no-autostart", "--url", server.URL, "--token", "0123456789abcdef0123456789abcdef", "do", "click 12", "click")
	if code != 2 || !strings.Contains(stdout, "> step 1: click") || !strings.Contains(stderr, "step 2 (click) failed") {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestJSONUnknownOutcomeIsOneResultWithoutReplay(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
		writeCompactJSON(w, map[string]any{"error": "extension disconnected after dispatch"})
	}))
	defer server.Close()
	code, stdout, stderr := runJSONCLI(t, server.URL, "do", "click 12", "click 14")
	if code != 1 || calls.Load() != 1 {
		t.Fatalf("code=%d calls=%d stdout=%s stderr=%s", code, calls.Load(), stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	if !strings.Contains(result["error"].(string), "outcome unknown") || result["failedStep"] == nil {
		t.Fatalf("uncertain dispatch was lost: %+v", result)
	}
}

func TestJSONFailedSnapshotDoesNotHideCompletedAction(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := map[string]any{"success": true}
		if calls.Add(1) == 2 {
			result = map[string]any{"error": "snapshot unavailable"}
		}
		writeCompactJSON(w, map[string]any{"result": result})
	}))
	defer server.Close()
	code, stdout, stderr := runJSONCLI(t, server.URL, "click", "12", "--snap")
	if code != 0 || calls.Load() != 2 {
		t.Fatalf("code=%d calls=%d stdout=%s stderr=%s", code, calls.Load(), stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	if result["snapshotError"] == nil || result["result"].(map[string]any)["success"] != true {
		t.Fatalf("completed action was misreported: %+v", result)
	}
}

func singleJSONResult(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal([]byte(stdout), &result); err != nil || result == nil {
		t.Fatalf("expected exactly one JSON object, got %q: %v", stdout, err)
	}
	if strings.Count(stdout, "\n") != 1 || !strings.HasSuffix(stdout, "\n") {
		t.Fatalf("expected a single JSON line, got %q", stdout)
	}
	return result
}

func runJSONCLI(t *testing.T, bridgeURL string, args ...string) (int, string, string) {
	t.Helper()
	flags := []string{"--json", "--no-autostart", "--token", "0123456789abcdef0123456789abcdef"}
	if bridgeURL != "" {
		flags = append(flags, "--url", bridgeURL)
	}
	return runCLIProcess(t, append(flags, args...)...)
}

func runCLIProcess(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	return runCLIProcessAtHome(t, t.TempDir(), args...)
}

func runCLIProcessAtHome(t *testing.T, home string, args ...string) (int, string, string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, append([]string{"-test.run=^TestCLIJSONProcess$", "--"}, args...)...)
	command.Env = append(os.Environ(), "BROWSERCONTROL_CLI_JSON_CHILD=1", "BROWSERCONTROL_HOME="+home, "BROWSERCONTROL_SESSION_ID=json-test")
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) && ctx.Err() == nil {
		return exit.ExitCode(), stdout.String(), stderr.String()
	}
	if err != nil {
		t.Fatalf("CLI child failed: %v, stderr=%s", err, stderr.String())
	}
	return 0, stdout.String(), stderr.String()
}

func TestCLIJSONProcess(t *testing.T) {
	if os.Getenv("BROWSERCONTROL_CLI_JSON_CHILD") != "1" {
		t.Skip("subprocess helper")
	}
	for i, arg := range os.Args {
		if arg == "--" {
			if os.Getenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE") == "1" {
				os.Exit(runCLI(os.Args[i+1:]))
			}
			if os.Getenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE") == "direct" {
				os.Exit(runCLI(append([]string{"direct"}, os.Args[i+1:]...)))
			}
			os.Exit(runExtension(os.Args[i+1:]))
		}
	}
	t.Fatal("missing CLI arguments separator")
}

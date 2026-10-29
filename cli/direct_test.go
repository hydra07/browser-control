package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestDefaultCLIHasNoBridgePath(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	var calls atomic.Int32
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer bridge.Close()
	t.Setenv("BROWSERCONTROL_URL", bridge.URL)
	for _, name := range []string{"serve", "server", "bridge", "status", "exec", "peek"} {
		code, stdout, stderr := runCLIProcess(t, name, "--json")
		if code != 2 {
			t.Fatalf("%s: code %d stdout=%s stderr=%s", name, code, stdout, stderr)
		}
		if singleJSONResult(t, stdout)["error"] == nil {
			t.Fatalf("%s: missing error", name)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("default route contacted legacy bridge %d times", calls.Load())
	}
	code, stdout, stderr := runCLIProcess(t, "help", "--json")
	if code != 0 || regexp.MustCompile(`(?m)^\s*(?:browsercontrol\s+)?(?:serve|server|bridge)(?:\s|$)`).MatchString(singleJSONResult(t, stdout)["help"].(string)) {
		t.Fatalf("default help advertises bridge: %d %s %s", code, stdout, stderr)
	}
	code, stdout, stderr = runCLIProcess(t, "browser", "status", "--profile", "agent", "--json")
	if code != 0 || singleJSONResult(t, stdout)["running"] != false {
		t.Fatalf("profile status requires bridge: %d %s %s", code, stdout, stderr)
	}
}

func TestDefaultBrowserLifecycleAcrossCLIProcesses(t *testing.T) {
	chrome := os.Getenv("BROWSERCONTROL_E2E_CHROME")
	if chrome == "" {
		t.Skip("set BROWSERCONTROL_E2E_CHROME for real Chrome acceptance")
	}
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	home := t.TempDir()
	args := []string{"browser", "start", "--profile", "e2e-custom", "--headless", "--executable", chrome, "--json"}
	if os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1" {
		args = append(args, "--no-sandbox")
	}
	code, stdout, stderr := runCLIProcessAtHome(t, home, args...)
	if code != 0 {
		t.Fatalf("start: %d %s %s", code, stdout, stderr)
	}
	started := singleJSONResult(t, stdout)
	t.Cleanup(func() { _, _, _ = runCLIProcessAtHome(t, home, "browser", "stop", "--profile", "e2e-custom", "--json") })
	if started["running"] != true || started["browserId"] == nil {
		t.Fatalf("invalid start: %+v", started)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "browser", "status", "--json")
	status := singleJSONResult(t, stdout)
	if code != 0 || status["profile"] != "e2e-custom" || status["running"] != true || status["browserId"] != started["browserId"] || status["pid"] != started["pid"] {
		t.Fatalf("CLI exit lost browser: %d %s %s", code, stdout, stderr)
	}
	if _, ok := status["endpoint"]; ok {
		t.Fatal("endpoint leaked in ordinary output")
	}
	if _, err := os.Stat(filepath.Join(home, "daemon-auth-token")); !os.IsNotExist(err) {
		t.Fatalf("direct CLI created bridge token: %v", err)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "browser", "stop", "--profile", "e2e-custom", "--session-id", "other-agent", "--json")
	if code != 1 || singleJSONResult(t, stdout)["error"] == nil {
		t.Fatalf("another session stopped the browser: %d %s %s", code, stdout, stderr)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "browser", "stop", "--json")
	if code != 0 || singleJSONResult(t, stdout)["running"] != false {
		t.Fatalf("stop: %d %s %s", code, stdout, stderr)
	}
}

func TestDirectLifecycleChecksSessionPolicyBeforeLaunch(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	home := t.TempDir()
	store, err := sessionstore.NewStore(home, "json-test")
	if err != nil {
		t.Fatal(err)
	}
	state := sessionstore.State{SchemaVersion: sessionstore.SchemaVersion, ID: "json-test", Permissions: &sessionstore.Permissions{Read: true}}
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := runCLIProcessAtHome(t, home, "browser", "start", "--executable", "missing-browser", "--json")
	if code != 1 || !strings.Contains(singleJSONResult(t, stdout)["error"].(string), "permission denied") {
		t.Fatalf("policy bypassed: %d %s %s", code, stdout, stderr)
	}
	if _, err := os.Stat(filepath.Join(home, "profiles")); !os.IsNotExist(err) {
		t.Fatalf("denied launch touched Chrome profiles: %v", err)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "browser", "status", "--json")
	if code != 0 || singleJSONResult(t, stdout)["running"] != false {
		t.Fatalf("read permission lost: %d %s %s", code, stdout, stderr)
	}
}

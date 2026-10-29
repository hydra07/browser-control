package main

import (
	"context"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestFixtureCommandHelpAndValidationAreOffline(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	code, stdout, stderr := runCLIProcess(t, "dev", "dump-fixture", "--help", "--json")
	if code != 0 || !strings.Contains(singleJSONResult(t, stdout)["help"].(string), "--allow-private") {
		t.Fatalf("fixture help: %d %s %s", code, stdout, stderr)
	}
	for _, args := range [][]string{
		{"dev", "dump-fixture", "file:///private"},
		{"dev", "dump-fixture", "https://example.test/?token=never-print-this"},
		{"dev", "dump-fixture", "fixture:unknown"},
		{"dev", "dump-fixture", "fixture:form", "--allow-private"},
		{"dev", "dump-fixture", "https://example.test/", "--target", "target"},
		{"dev", "dump-fixture", "https://example.test/", "--allow-private", "--out", "fixtures/public/private.json"},
		{"dev", "dump-fixture", "fixture:form", "--max-nodes", "0"},
		{"browser", "status", "--allow-private"},
	} {
		code, stdout, stderr := runCLIProcess(t, append(args, "--json")...)
		if code != 2 || singleJSONResult(t, stdout)["error"] == nil || strings.Contains(stdout+stderr, "never-print-this") {
			t.Fatalf("fixture validation: %v %d %s %s", args, code, stdout, stderr)
		}
	}
}

func TestFixtureCommandCapturesAcrossCLIProcesses(t *testing.T) {
	chrome := os.Getenv("BROWSERCONTROL_E2E_CHROME")
	if chrome == "" {
		t.Skip("set BROWSERCONTROL_E2E_CHROME for real Chrome acceptance")
	}
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	home, out := t.TempDir(), filepath.Join(t.TempDir(), "form.json")
	args := []string{"browser", "start", "--headless", "--executable", chrome, "--json"}
	if os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1" {
		args = append(args, "--no-sandbox")
	}
	code, stdout, stderr := runCLIProcessAtHome(t, home, args...)
	if code != 0 {
		t.Fatalf("start: %d %s %s", code, stdout, stderr)
	}
	t.Cleanup(func() { _, _, _ = runCLIProcessAtHome(t, home, "browser", "stop", "--json") })
	code, stdout, stderr = runCLIProcessAtHome(t, home, "dev", "dump-fixture", "fixture:form", "--out", out, "--json")
	if code != 0 {
		t.Fatalf("capture: %d %s %s", code, stdout, stderr)
	}
	result := singleJSONResult(t, stdout)
	if result["path"] != out || result["classification"] != "synthetic" || result["truncated"] != false || len(stdout) > 1500 {
		t.Fatalf("noncompact capture result: %s", stdout)
	}
	data, err := os.ReadFile(out)
	if err != nil || !strings.Contains(string(data), "mai@example.test") || !strings.Contains(string(data), `"accessibility"`) {
		t.Fatalf("capture artifact missing: %v", err)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "dev", "dump-fixture", "fixture:form", "--out", out, "--json")
	if code != 2 {
		t.Fatalf("capture overwrote existing output: %d %s %s", code, stdout, stderr)
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "dev", "dump-fixture", "fixture:nested-frames", "--max-frames", "1", "--out", filepath.Join(t.TempDir(), "limited.json"), "--json")
	if code != 0 {
		t.Fatalf("limited capture: %d %s %s", code, stdout, stderr)
	}
	limited := singleJSONResult(t, stdout)
	if limited["truncated"] != true || limited["frames"] != float64(1) || limited["missingFrameCount"] != float64(2) || limited["missingFrames"] != nil || len(stdout) > 1500 {
		t.Fatalf("coverage result was not bounded/explicit: %s", stdout)
	}
	checkPrivateFixtureCLI(t, home)
}

func checkPrivateFixtureCLI(t *testing.T, home string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manager, err := sessionstore.NewBrowserManager(home)
	if err != nil {
		t.Fatal(err)
	}
	info, err := manager.Status(ctx, "agent")
	if err != nil {
		t.Fatal(err)
	}
	client, err := cdp.Connect(ctx, info.Endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><title>Private CLI fixture</title><input name="email" value="mai@example.test"><input type="password" value="private-cli-fixture-value">`))
	}))
	defer server.Close()
	page, err := client.NewPage(ctx, server.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	for {
		world, err := page.IsolatedWorld(ctx, "fixture-cli-setup")
		if err == nil {
			ready, err := world.Evaluate(ctx, `document.readyState === 'complete' && !!document.querySelector('input[type=password]')`)
			if err == nil && string(ready) == "true" {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("private CLI fixture not ready")
		case <-time.After(25 * time.Millisecond):
		}
	}
	if err := page.Close(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := sessionstore.NewStore(home, "json-test")
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	originalState := state
	t.Cleanup(func() {
		if err := store.Save(originalState); err != nil {
			t.Error(err)
		}
	})
	state.Permissions = &sessionstore.Permissions{Read: true}
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	root, err := devtools.Worktree(ctx)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "data", "fixtures", "private", "cli-test-"+rand.Text()+".json")
	t.Cleanup(func() { _ = os.Remove(out) })
	code, stdout, stderr := runCLIProcessAtHome(t, home, "dev", "dump-fixture", server.URL+"/", "--allow-private", "--target", page.ID(), "--out", out, "--json")
	if code != 0 || singleJSONResult(t, stdout)["classification"] != "private" {
		t.Fatalf("private CLI capture with read-only policy: %d %s %s", code, stdout, stderr)
	}
	data, err := os.ReadFile(out)
	if err != nil || strings.Contains(string(data), "private-cli-fixture-value") || !strings.Contains(string(data), "mai@example.test") {
		t.Fatalf("private artifact not sanitized: %v", err)
	}
	other, err := sessionstore.NewStore(home, "fixture-other")
	if err != nil {
		t.Fatal(err)
	}
	state.ID = "fixture-other"
	if err := other.Save(state); err != nil {
		t.Fatal(err)
	}
	denied := filepath.Join(root, "data", "fixtures", "private", "denied-"+rand.Text()+".json")
	t.Cleanup(func() { _ = os.Remove(denied) })
	code, stdout, stderr = runCLIProcessAtHome(t, home, "dev", "dump-fixture", server.URL+"/", "--allow-private", "--session-id", "fixture-other", "--out", denied, "--json")
	if code != 1 || !strings.Contains(singleJSONResult(t, stdout)["error"].(string), "tab_owned") {
		t.Fatalf("another session bypassed lease: %d %s %s", code, stdout, stderr)
	}
	if _, err := os.Stat(denied); !os.IsNotExist(err) {
		t.Fatal("lease denial published an artifact")
	}
	code, stdout, stderr = runCLIProcessAtHome(t, home, "dev", "dump-fixture", "fixture:form", "--out", filepath.Join(t.TempDir(), "denied-public.json"), "--json")
	if code != 1 || !strings.Contains(singleJSONResult(t, stdout)["error"].(string), "permission denied") {
		t.Fatalf("anonymous navigation bypassed read-only policy: %d %s %s", code, stdout, stderr)
	}
}

func TestFixtureSessionPolicyCheckedBeforeBrowserAccess(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "direct")
	for _, policy := range []sessionstore.Permissions{{Read: false, Act: true}, {Read: true, Act: false}} {
		home := t.TempDir()
		store, err := sessionstore.NewStore(home, "json-test")
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Save(sessionstore.State{ID: "json-test", SchemaVersion: sessionstore.SchemaVersion, Permissions: &policy}); err != nil {
			t.Fatal(err)
		}
		code, stdout, stderr := runCLIProcessAtHome(t, home, "dev", "dump-fixture", "fixture:form", "--json")
		if code != 1 || !strings.Contains(singleJSONResult(t, stdout)["error"].(string), "permission denied") {
			t.Fatalf("policy not checked first: %d %s %s", code, stdout, stderr)
		}
		if _, err := os.Stat(filepath.Join(home, "profiles")); !os.IsNotExist(err) {
			t.Fatal("denied fixture command touched profiles")
		}
	}
}

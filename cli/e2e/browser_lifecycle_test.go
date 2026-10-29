package e2e

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestChromeManagedProfileStartStopAndLoginPersistence(t *testing.T) {
	bin := chromeExecutable(t)
	manager, err := session.NewBrowserManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	options := session.BrowserOptions{Profile: "agent", Executable: bin, Headless: true, NoSandbox: runtime.GOOS == "linux" && (os.Geteuid() == 0 || os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1")}
	first, err := manager.Start(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = manager.Stop(cleanup, "agent")
	})
	if !first.Running || first.ID == "" || first.PID <= 0 {
		t.Fatalf("start: %+v", first)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(first.ProfilePath)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("profile permissions: %v %v", info, err)
		}
	}
	reused, err := manager.Start(ctx, options)
	if err != nil || reused.ID != first.ID || reused.PID != first.PID || !reused.Reused {
		t.Fatalf("start did not reuse owned browser: %+v %v", reused, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "<!doctype html><title>Profile fixture</title><p>Cookie fixture</p>")
	}))
	defer server.Close()
	client, err := cdp.Connect(ctx, first.Endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	target, err := client.NewPage(ctx, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var world *cdp.World
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		world, err = target.IsolatedWorld(ctx, "profile-test")
		if err == nil {
			if _, err = world.Evaluate(ctx, `document.cookie='bc_fixture=persisted; Path=/; Max-Age=3600'; document.cookie`); err == nil {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(first.ProfilePath, "browsercontrol-owner.json")
	original, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(original, &metadata); err != nil {
		t.Fatal(err)
	}
	process := metadata["process"].(map[string]any)
	process["pid"] = os.Getpid()
	process["started"], err = session.ProcessStart(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	bad, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metadataPath, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	needsRestore := true
	defer func() {
		if needsRestore {
			_ = os.WriteFile(metadataPath, original, 0o600)
		}
	}()
	if _, err := manager.Stop(ctx, "agent"); err == nil {
		t.Fatal("unowned process accepted for stop")
	}
	if _, err := client.Version(ctx); err != nil {
		t.Fatal("ownership refusal still closed Chrome", err)
	}
	if err := os.WriteFile(metadataPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	needsRestore = false
	stopped, err := manager.Stop(ctx, "agent")
	if err != nil || stopped.Running {
		t.Fatalf("stop: %+v %v", stopped, err)
	}
	second, err := manager.Start(ctx, options)
	if err != nil || second.ID == first.ID {
		t.Fatalf("restart: %+v %v", second, err)
	}
	next, err := cdp.Connect(ctx, second.Endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	target, err = next.NewPage(ctx, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	var cookie json.RawMessage
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		world, err = target.IsolatedWorld(ctx, "profile-test")
		if err == nil {
			cookie, err = world.Evaluate(ctx, `document.cookie`)
			if err == nil && strings.Contains(string(cookie), "bc_fixture=persisted") {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || !strings.Contains(string(cookie), "bc_fixture=persisted") {
		t.Fatalf("synthetic login state did not survive profile restart: %s %v", cookie, err)
	}
}

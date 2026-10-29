package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestDirectAgentNativeCLI(t *testing.T) {
	chrome := os.Getenv("BROWSERCONTROL_E2E_CHROME")
	if chrome == "" {
		t.Skip("set BROWSERCONTROL_E2E_CHROME for native CLI acceptance")
	}
	root := t.TempDir()
	binary := os.Getenv("BROWSERCONTROL_E2E_CLI_BINARY")
	if binary == "" {
		binary = filepath.Join(root, "browsercontrol")
		if runtime.GOOS == "windows" {
			binary += ".exe"
		}
		build := exec.Command("go", "build", "-o", binary, ".")
		if data, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build native CLI: %v %s", err, data)
		}
	}
	var bridgeCalls atomic.Int32
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { bridgeCalls.Add(1); w.WriteHeader(500) }))
	defer bridge.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><title>Agent form</title><h1>Agent fixture</h1>
<form onsubmit="event.preventDefault();document.querySelector('#status').textContent='Saved '+document.querySelector('#name').value">
<label>Name <input id="name" value="old"></label><label>Password <input type="password" value="fixture-password-never-output"></label><button>Save profile</button></form>
<p id="status">Ready</p><button id="target" onclick="document.querySelector('#count').textContent='Count: 1'">Target</button>
<button id="replace" onclick="const n=document.createElement('button');n.id='target';n.textContent='Target';n.onclick=()=>document.querySelector('#count').textContent='Count: 1';document.querySelector('#target').replaceWith(n)">Replace target</button>
<button id="move" onclick="document.body.prepend(document.querySelector('#target'))">Move target</button><p id="count">Count: 0</p>
<div id="shadow"></div><script>
const root = document.querySelector('#shadow').attachShadow({mode: 'open'});
root.innerHTML = '<label>Shadow field <input></label><button>Save shadow</button>';
root.querySelector('button').onclick = () => {
    document.querySelector('#status').textContent = 'Shadow saved ' + root.querySelector('input').value;
};
</script>`))
	}))
	defer server.Close()
	home := filepath.Join(root, "home")
	run := func(args ...string) (int, string, map[string]any) {
		ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, binary, append(append([]string{"direct"}, args...), "--json")...)
		command.Env = append(os.Environ(), "BROWSERCONTROL_HOME="+home, "BROWSERCONTROL_SESSION_ID=agent-acceptance", "BROWSERCONTROL_URL="+bridge.URL)
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		err := command.Run()
		code := 0
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			code = exited.ExitCode()
		} else if err != nil {
			t.Fatalf("native CLI failed: %v %s", err, stderr.String())
		}
		value := singleJSONResult(t, stdout.String())
		if stderr.Len() != 0 {
			t.Fatalf("JSON stderr: %s", stderr.String())
		}
		return code, stdout.String(), value
	}
	ok := func(args ...string) map[string]any {
		code, stdout, _ := run(args...)
		if code != 0 {
			t.Fatalf("%v: exit %d %s", args, code, stdout)
		}
		var value map[string]any
		_ = json.Unmarshal([]byte(stdout), &value)
		return value
	}
	t.Cleanup(func() { _, _, _ = run("browser", "stop") })
	args := []string{"open", server.URL, "--headless", "--executable", chrome}
	if os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1" {
		args = append(args, "--no-sandbox")
	}
	ok(args...)
	snapshot := func() map[string]any { return ok("snapshot")["snapshot"].(map[string]any) }
	ref := func(value map[string]any, name string) string {
		for _, raw := range value["nodes"].([]any) {
			node := raw.(map[string]any)
			if node["name"] == name {
				return strconv.Itoa(int(node["id"].(float64)))
			}
		}
		t.Fatalf("missing node %s", name)
		return ""
	}
	first := snapshot()
	name := ref(first, "Name")
	target := ref(first, "Target")
	if data, _ := json.Marshal(first); bytes.Contains(data, []byte("fixture-password-never-output")) {
		t.Fatal("password leaked")
	}
	ok("fill", name, "")
	ok("press", "Shift+a")
	for _, raw := range snapshot()["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["name"] == "Name" && node["value"] != "A" {
			t.Fatalf("Shift+a did not enter uppercase text: %v", node)
		}
	}
	ok("fill", name, "Ada Lovelace")
	ok("click", ref(first, "Save profile"))
	ok("wait", "Saved Ada Lovelace")
	if !strings.Contains(ok("read")["text"].(string), "Saved Ada Lovelace") {
		t.Fatal("form effect missing")
	}
	ok("fill", ref(first, "Shadow field"), "visible")
	ok("click", ref(first, "Save shadow"))
	ok("wait", "Shadow saved visible")
	ok("click", "#move")
	if got := ref(snapshot(), "Target"); got != target {
		t.Fatalf("reorder changed physical ref: %s -> %s", target, got)
	}
	ok("click", "#replace")
	code, stdout, _ := run("click", target)
	if code != 1 || !strings.Contains(stdout, "stale_target") {
		t.Fatalf("replacement reused old ref: %d %s", code, stdout)
	}
	current := snapshot()
	next := ref(current, "Target")
	if next == target {
		t.Fatal("replacement aliased old ref")
	}
	ok("click", next)
	ok("wait", "Count: 1")
	code, stdout, _ = run("click", "button")
	if code != 1 || !strings.Contains(stdout, "target_ambiguous") {
		t.Fatalf("ambiguous CSS accepted: %d %s", code, stdout)
	}
	if shown := ok("snapshot", "--limit", "1")["shown"]; shown != float64(1) {
		t.Fatalf("limit ignored: %v", shown)
	}
	ok("press", "Control+a")
	shot := filepath.Join(root, "screenshot.png")
	ok("screenshot", shot)
	file, err := os.Open(shot)
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(file)
	_ = file.Close()
	if err != nil || config.Width <= 0 {
		t.Fatalf("invalid screenshot: %v", err)
	}
	code, _, _ = run("screenshot", shot)
	if code != 1 {
		t.Fatal("existing screenshot overwritten")
	}
	ok("scroll", "down")
	ok("open", server.URL)
	code, stdout, _ = run("click", next)
	if code != 1 || !strings.Contains(stdout, "stale_target") {
		t.Fatalf("navigation accepted old ref: %d %s", code, stdout)
	}
	snapshot()
	ok("open", server.URL, "--new-tab")
	pages := ok("tabs")["tabs"].([]any)
	if len(pages) != 2 {
		t.Fatalf("expected two tabs: %v", pages)
	}
	ok("tabs", "switch", pages[0].(map[string]any)["id"].(string))
	snapshot()
	ok("tabs", "close", pages[1].(map[string]any)["id"].(string))
	store, err := sessionstore.NewStore(home, "agent-acceptance")
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	state.Permissions = &sessionstore.Permissions{Read: true, Act: false}
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = run("click", "#target")
	if code != 1 || !strings.Contains(stdout, "permission denied") {
		t.Fatalf("read-only policy bypassed: %d %s", code, stdout)
	}
	state.Permissions = nil
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	lock, err := store.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	intentJournal, err := store.OpenJournal(lock)
	if err != nil {
		t.Fatal(err)
	}
	_, err = intentJournal.Begin(context.Background(), sessionstore.ActionIntent{ActionID: "a_native_fault", Kind: driver.Click, StartedAt: time.Now().UnixMilli(), Scope: sessionstore.ActionScope{BrowserID: state.Browser.ID, TargetID: state.DirectTarget}})
	if err != nil {
		t.Fatal(err)
	}
	_ = lock.Close()
	if len(ok("pending")["pending"].([]any)) != 1 {
		t.Fatal("missing uncertain action")
	}
	code, stdout, _ = run("click", "#target")
	if code != 1 || !strings.Contains(stdout, "pending_action") {
		t.Fatalf("pending action not gated: %d %s", code, stdout)
	}
	ok("read")
	if ok("ack", "a_native_fault", "--ack-unknown")["verified"] != false {
		t.Fatal("ack invented verification")
	}
	ok("click", "#target")
	if bridgeCalls.Load() != 0 {
		t.Fatalf("direct CLI contacted bridge %d times", bridgeCalls.Load())
	}
	if _, err := os.Stat(filepath.Join(home, "daemon-auth-token")); !os.IsNotExist(err) {
		t.Fatal("direct CLI created a bridge token")
	}
	journal, err := os.ReadFile(filepath.Join(home, "sessions", "agent-acceptance", "actions.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(journal, []byte("Ada Lovelace")) || bytes.Contains(journal, []byte("fixture-password-never-output")) {
		t.Fatal("typed payload persisted in journal")
	}
}

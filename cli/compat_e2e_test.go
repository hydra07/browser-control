package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCompatibilityNativeExistingChrome(t *testing.T) {
	if os.Getenv("BROWSERCONTROL_E2E_EXISTING_EXTENSION") != "1" {
		t.Skip("explicitly opt in to the installed, paired extension on the user's running Chrome")
	}
	binary := os.Getenv("BROWSERCONTROL_E2E_CLI_BINARY")
	if binary == "" {
		t.Fatal("set BROWSERCONTROL_E2E_CLI_BINARY to the built native executable")
	}
	root := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<!doctype html><title>BrowserControl compatibility acceptance</title><form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Saved '+document.querySelector('#fixture-name').value"><label>Fixture Name <input id="fixture-name"></label><button id="fixture-save">Save compatibility</button></form><p id="result">Ready</p>`)
	}))
	defer server.Close()
	run := func(args ...string) map[string]any {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, binary, append(args, "--session-id", "compatibility-acceptance", "--json")...)
		command.Env = append(os.Environ(), "BROWSERCONTROL_HOME="+filepath.Join(root, "home"))
		var stdout, stderr bytes.Buffer
		command.Stdout, command.Stderr = &stdout, &stderr
		started := time.Now()
		if err := command.Run(); err != nil {
			t.Fatalf("native %s failed: %v %s %s", args[0], err, stdout.String(), stderr.String())
		}
		if stderr.Len() != 0 {
			t.Fatalf("native %s stderr: %s", args[0], stderr.String())
		}
		var result map[string]any
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		t.Logf("native default %s passed (%s)", args[0], time.Since(started).Round(time.Millisecond))
		return result
	}
	before := run("tabs")
	originalTabs, ok := before["tabs"].([]any)
	if !ok || len(originalTabs) == 0 {
		t.Fatal("running Chrome returned no existing tabs")
	}
	opened := run("open", server.URL, "--new-tab", "--background")
	id, ok := opened["tabId"].(float64)
	if !ok || id <= 0 {
		t.Fatal("new synthetic tab has no ID")
	}
	tab := strconv.Itoa(int(id))
	t.Cleanup(func() { run("tabs", "close", tab) })
	flat := run("snapshot", "--tab", tab)
	if !strings.Contains(fmt.Sprint(flat), "Save compatibility") {
		t.Fatal("snapshot did not observe synthetic controls")
	}
	run("do", "type #fixture-name 'Compatibility restored' --clear", "click #fixture-save", "wait 'Saved Compatibility restored'", "snapshot --semantic", "--tab", tab)
	observed := run("snapshot", "--semantic", "--diff", "--tab", tab)
	if observed["scope"] == nil {
		t.Fatal("semantic snapshot lost document scope")
	}
	shot := filepath.Join(root, "synthetic.png")
	run("screenshot", shot, "--tab", tab)
	file, err := os.Open(shot)
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(file)
	_ = file.Close()
	if err != nil || config.Width <= 0 {
		t.Fatalf("invalid synthetic screenshot: %v", err)
	}
	after := run("tabs")
	remaining := map[float64]bool{}
	for _, raw := range after["tabs"].([]any) {
		remaining[raw.(map[string]any)["id"].(float64)] = true
	}
	for _, raw := range originalTabs {
		if !remaining[raw.(map[string]any)["id"].(float64)] {
			t.Fatal("an original browser tab disappeared")
		}
	}
}

package baseline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
)

type browser struct {
	command     *exec.Cmd
	probe       *cdp.BenchmarkProbe
	page        cdp.BenchmarkPage
	pid         int
	workerNames []string
}

func fixtureHTML() string {
	var html strings.Builder
	html.WriteString(`<!doctype html><html lang="en"><title>Baseline synthetic controls</title><body><h1>Baseline inventory</h1><label>Filter <input aria-label="Filter" value="synthetic"></label><table><thead><tr><th>Item</th><th>Count</th><th>Action</th></tr></thead><tbody>`)
	for i := 1; i <= 100; i++ {
		fmt.Fprintf(&html, `<tr><td>Fixture item %03d</td><td>%d</td><td><button>Open item %03d</button></td></tr>`, i, i*3, i)
	}
	html.WriteString(`</tbody></table></body></html>`)
	return html.String()
}

func fixtureServer() (*httptest.Server, string) {
	html := fixtureHTML()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/baseline" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, html)
	}))
	return server, hash([]byte(html))
}

func launch(ctx context.Context, c Config, runDir, pageURL string, extension bool) (*browser, error) {
	profile, err := os.MkdirTemp(runDir, "profile-")
	if err != nil {
		return nil, err
	}
	args := []string{"--headless=new", "--remote-debugging-port=0", "--enable-automation", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "--window-size=1280,800", "--user-data-dir=" + profile}
	if extension {
		args = append(args, "--load-extension="+c.Extension, "--disable-extensions-except="+c.Extension)
	}
	args = append(args, "about:blank")
	command := exec.CommandContext(ctx, c.Chrome, args...)
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	b := &browser{command: command, pid: command.Process.Pid}
	ready := false
	defer func() {
		if !ready {
			b.close()
		}
	}()
	deadline := time.Now().Add(30 * time.Second)
	var endpoint string
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(filepath.Join(profile, "DevToolsActivePort"))
		if err == nil {
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(lines) == 2 && strings.HasPrefix(lines[1], "/devtools/browser/") {
				endpoint = "ws://127.0.0.1:" + strings.TrimSpace(lines[0]) + strings.TrimSpace(lines[1])
				break
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	if endpoint == "" {
		return nil, errors.New("owned Chrome did not publish DevToolsActivePort")
	}
	b.probe, err = cdp.OpenBenchmarkProbe(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	processes, err := b.probe.Processes(ctx)
	if err != nil {
		return nil, err
	}
	found := false
	for _, process := range processes {
		if process.Type == "browser" && process.ID == b.pid {
			found = true
		}
	}
	if !found {
		return nil, errors.New("Chrome process inventory does not match launched browser PID")
	}
	if _, err := readProcess(b.pid, c.Chrome); err != nil {
		return nil, err
	}
	b.page, err = b.probe.IdentifyPage(ctx, pageURL)
	if err != nil {
		return nil, err
	}
	reading, err := readProcess(b.page.RendererPID, c.Chrome)
	if err != nil || reading.ParentPID != b.pid {
		return nil, fmt.Errorf("trace renderer PID does not match owned Chrome child: %w", err)
	}
	ready = true
	return b, nil
}

func (b *browser) close() {
	if b.probe != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = b.probe.CloseBrowser(ctx)
		cancel()
		_ = b.probe.Close()
	}
	// Only this exact child handle is eligible for termination; user browser PIDs are never searched.
	_ = b.command.Process.Kill()
	_ = b.command.Wait()
}

func (b *browser) extensionID(ctx context.Context, extension string, required bool) (string, error) {
	data, err := os.ReadFile(filepath.Join(extension, "manifest.json"))
	if err != nil {
		return "", err
	}
	var expected struct{ Name, Version string }
	if err := json.Unmarshal(data, &expected); err != nil || expected.Name == "" || expected.Version == "" {
		return "", errors.New("invalid benchmark extension manifest")
	}
	for attempt := 0; attempt < 100; attempt++ {
		targets, err := b.probe.Targets(ctx)
		if err != nil {
			return "", err
		}
		var ids []string
		b.workerNames = nil
		for _, target := range targets {
			if target.Type == "service_worker" && strings.HasPrefix(target.URL, "chrome-extension://") {
				name, version, err := b.probe.WorkerManifest(ctx, target.ID)
				if err != nil {
					return "", err
				}
				b.workerNames = append(b.workerNames, name+" "+version)
				if name != expected.Name || version != expected.Version {
					continue
				}
				parts := strings.Split(strings.TrimPrefix(target.URL, "chrome-extension://"), "/")
				ids = append(ids, parts[0])
			}
		}
		if !required {
			return "", nil
		}
		if len(ids) == 1 && len(ids[0]) == 32 {
			return ids[0], nil
		}
		if len(ids) > 1 {
			return "", errors.New("isolated profile loaded ambiguous copies of the benchmark extension")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return "", errors.New("original extension service worker did not load")
}

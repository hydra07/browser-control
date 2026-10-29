package e2e

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed testdata/*.html
var fixtures embed.FS

type chromeHarness struct {
	ctx      context.Context
	endpoint string
	profile  string
	pid      int
	version  string
	server   *httptest.Server
	client   *testConnection
}

type testPage struct {
	h        *chromeHarness
	client   *testConnection
	targetID string
	session  string
}

type testConnection struct {
	ws *websocket.Conn
	mu sync.Mutex
	id uint64
}

func startChrome(t *testing.T) *chromeHarness {
	t.Helper()
	bin := chromeExecutable(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	fixtureDir, err := fs.Sub(fixtures, "testdata")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.FileServerFS(fixtureDir))
	t.Cleanup(server.Close)
	log, err := os.Create(filepath.Join(root, "chrome.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = log.Close() })
	args := []string{
		"--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile,
		"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--enable-automation",
		"--disable-background-networking", "--disable-sync", "about:blank",
	}
	if runtime.GOOS == "linux" && (os.Geteuid() == 0 || os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1") {
		args = append(args, "--no-sandbox")
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		t.Fatalf("start owned test Chrome: %v", err)
	}
	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
		close(exited)
	}()
	h := &chromeHarness{ctx: ctx, server: server, profile: profile, pid: cmd.Process.Pid}
	t.Cleanup(func() {
		if h.client != nil {
			_ = h.client.ws.Close()
		}
		select {
		case <-exited:
			return
		default:
		}
		if h.endpoint != "" {
			closeCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
			if client, err := dialTestConnection(closeCtx, h.endpoint); err == nil {
				_ = client.call(closeCtx, "", "Browser.close", nil, nil)
				_ = client.ws.Close()
			}
			stop()
		}
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			select {
			case <-exited:
			case <-time.After(3 * time.Second):
				t.Error("owned test Chrome did not exit after cleanup")
			}
		}
	})
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	startup, stopStartup := context.WithTimeout(ctx, 10*time.Second)
	defer stopStartup()
	for h.endpoint == "" {
		if data, err := os.ReadFile(filepath.Join(profile, "DevToolsActivePort")); err == nil {
			lines := strings.Fields(string(data))
			if len(lines) == 2 {
				port, err := strconv.Atoi(lines[0])
				if err == nil && port > 0 && port <= 65535 && strings.HasPrefix(lines[1], "/devtools/browser/") {
					h.endpoint = "ws://" + net.JoinHostPort("127.0.0.1", lines[0]) + lines[1]
					break
				}
			}
		}
		select {
		case err := <-exited:
			t.Fatalf("test Chrome exited before publishing DevToolsActivePort: %v", err)
		case <-startup.Done():
			t.Fatalf("wait for DevToolsActivePort: %v", startup.Err())
		case <-ticker.C:
		}
	}
	h.client, err = dialTestConnection(ctx, h.endpoint)
	if err != nil {
		t.Fatal(err)
	}
	var version struct{ Product string }
	if err := h.client.call(ctx, "", "Browser.getVersion", nil, &version); err != nil {
		t.Fatal(err)
	}
	h.version = version.Product
	t.Logf("owned temporary-profile browser: %s", h.version)
	return h
}

func chromeExecutable(t *testing.T) string {
	t.Helper()
	bin := strings.TrimSpace(os.Getenv("BROWSERCONTROL_E2E_CHROME"))
	if bin == "" {
		if os.Getenv("BROWSERCONTROL_E2E_REQUIRED") == "1" {
			t.Fatal("BROWSERCONTROL_E2E_CHROME is required for this E2E run")
		}
		t.Skip("set BROWSERCONTROL_E2E_CHROME to an explicit Chrome/Chromium executable")
	}
	if info, err := os.Stat(bin); err != nil || info.IsDir() {
		t.Fatalf("invalid BROWSERCONTROL_E2E_CHROME executable: %s", bin)
	}
	return bin
}

func dialTestConnection(ctx context.Context, endpoint string) (*testConnection, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	ws, _, err := dialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return nil, err
	}
	return &testConnection{ws: ws}, nil
}

func (c *testConnection) call(ctx context.Context, session, method string, params, result any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	c.id++
	message := map[string]any{"id": c.id, "method": method, "params": params}
	if params == nil {
		message["params"] = map[string]any{}
	}
	if session != "" {
		message["sessionId"] = session
	}
	_ = c.ws.SetWriteDeadline(deadline)
	if err := c.ws.WriteJSON(message); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	_ = c.ws.SetReadDeadline(deadline)
	for {
		var reply struct {
			ID     uint64
			Result json.RawMessage
			Error  *struct {
				Code    int
				Message string
			}
		}
		if err := c.ws.ReadJSON(&reply); err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		if reply.ID != c.id {
			continue
		}
		if reply.Error != nil {
			return fmt.Errorf("%s: CDP %d: %s", method, reply.Error.Code, reply.Error.Message)
		}
		if result != nil {
			return json.Unmarshal(reply.Result, result)
		}
		return nil
	}
}

func (h *chromeHarness) open(t *testing.T, path string) *testPage {
	t.Helper()
	var created struct{ TargetID string }
	if err := h.client.call(h.ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		t.Fatal(err)
	}
	p := h.attach(t, created.TargetID)
	p.navigate(t, path)
	return p
}

func (h *chromeHarness) attach(t *testing.T, targetID string) *testPage {
	t.Helper()
	var attached struct{ SessionID string }
	if err := h.client.call(h.ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &attached); err != nil {
		t.Fatal(err)
	}
	p := &testPage{h: h, client: h.client, targetID: targetID, session: attached.SessionID}
	p.call(t, "Page.enable", nil, nil)
	return p
}

func (h *chromeHarness) reconnect(t *testing.T) {
	t.Helper()
	_ = h.client.ws.Close()
	client, err := dialTestConnection(h.ctx, h.endpoint)
	if err != nil {
		t.Fatal(err)
	}
	h.client = client
}

func (h *chromeHarness) waitDetached(t *testing.T, targetID string) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		var result struct{ TargetInfo struct{ Attached bool } }
		if err := h.client.call(h.ctx, "", "Target.getTargetInfo", map[string]any{"targetId": targetID}, &result); err != nil {
			t.Fatal(err)
		}
		if !result.TargetInfo.Attached {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("closing the previous WebSocket did not detach its target session")
}

func (p *testPage) request(method string, params, result any) error {
	return p.client.call(p.h.ctx, p.session, method, params, result)
}

func (p *testPage) call(t *testing.T, method string, params, result any) {
	t.Helper()
	if err := p.request(method, params, result); err != nil {
		t.Fatal(err)
	}
}

func (p *testPage) navigate(t *testing.T, path string) {
	t.Helper()
	wantURL := p.h.server.URL + path
	var result struct{ ErrorText string }
	p.call(t, "Page.navigate", map[string]any{"url": wantURL}, &result)
	if result.ErrorText != "" {
		t.Fatal(result.ErrorText)
	}
	quotedURL, _ := json.Marshal(wantURL)
	p.wait(t, `location.href === `+string(quotedURL)+` && document.readyState === "complete" && document.body?.dataset.fixture === "controls"`)
}

func (p *testPage) evaluate(contextID int, expression string) (json.RawMessage, error) {
	params := map[string]any{"expression": expression, "returnByValue": true, "awaitPromise": true}
	if contextID != 0 {
		params["contextId"] = contextID
	}
	var result struct {
		Result           struct{ Value json.RawMessage }
		ExceptionDetails json.RawMessage
	}
	if err := p.request("Runtime.evaluate", params, &result); err != nil {
		return nil, err
	}
	if len(result.ExceptionDetails) > 0 && string(result.ExceptionDetails) != "null" {
		return nil, fmt.Errorf("Runtime.evaluate returned exceptionDetails: %s", result.ExceptionDetails)
	}
	return result.Result.Value, nil
}

func (p *testPage) eval(t *testing.T, expression string, result any) {
	t.Helper()
	p.evalIn(t, 0, expression, result)
}

func (p *testPage) evalIn(t *testing.T, contextID int, expression string, result any) {
	t.Helper()
	value, err := p.evaluate(contextID, expression)
	if err != nil {
		t.Fatal(err)
	}
	if result != nil {
		if err := json.Unmarshal(value, result); err != nil {
			t.Fatal(err)
		}
	}
}

func (p *testPage) wait(t *testing.T, expression string) {
	t.Helper()
	var lastErr error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		value, err := p.evaluate(0, expression)
		if err == nil && string(value) == "true" {
			return
		}
		lastErr = err
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fixture condition did not become true: %s (last evaluation error: %v)", expression, lastErr)
}

func (p *testPage) isolatedWorld(t *testing.T) int {
	t.Helper()
	var tree struct {
		FrameTree struct{ Frame struct{ ID string } }
	}
	p.call(t, "Page.getFrameTree", nil, &tree)
	var world struct{ ExecutionContextID int }
	p.call(t, "Page.createIsolatedWorld", map[string]any{
		"frameId": tree.FrameTree.Frame.ID, "worldName": "browsercontrol-e2e-probe",
	}, &world)
	if world.ExecutionContextID == 0 {
		t.Fatal("Chrome did not return an isolated execution context")
	}
	return world.ExecutionContextID
}

func (p *testPage) click(t *testing.T, backendID int) {
	t.Helper()
	var result struct{ Model struct{ Content []float64 } }
	p.call(t, "DOM.getBoxModel", map[string]any{"backendNodeId": backendID}, &result)
	quad := result.Model.Content
	if len(quad) != 8 {
		t.Fatal("Chrome did not return an actionable fixture box")
	}
	x, y := (quad[0]+quad[4])/2, (quad[1]+quad[5])/2
	for _, eventType := range []string{"mousePressed", "mouseReleased"} {
		p.call(t, "Input.dispatchMouseEvent", map[string]any{
			"type": eventType, "x": x, "y": y, "button": "left", "clickCount": 1,
		}, nil)
	}
}

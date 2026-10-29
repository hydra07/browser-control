package baseline

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type bridge struct {
	command *exec.Cmd
	env     []string
	baseURL string
	token   string
	binary  string
}

func startBridge(ctx context.Context, c Config, home, extensionID string) (*bridge, error) {
	token := rand.Text() + rand.Text()
	var env []string
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !strings.HasPrefix(strings.ToUpper(key), "BROWSERCONTROL_") {
			env = append(env, value)
		}
	}
	env = append(env, "BROWSERCONTROL_HOME="+home, "BROWSERCONTROL_AUTH_TOKEN="+token, "BROWSERCONTROL_EXTENSION_ID="+extensionID)
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", c.Port)
	command := exec.CommandContext(ctx, c.Bridge, "serve", "--port", strconv.Itoa(c.Port), "--url", baseURL)
	command.Env, command.Dir = env, home
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	b := &bridge{command: command, env: env, baseURL: baseURL, token: token, binary: c.Bridge}
	for attempt := 0; attempt < 300; attempt++ {
		var status struct{ ExtensionConnected bool }
		if b.request(ctx, "GET", "/status", nil, &status) == nil && status.ExtensionConnected {
			return b, nil
		}
		select {
		case <-ctx.Done():
			b.close()
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	b.close()
	return nil, errors.New("isolated original bridge/extension did not become ready")
}

func (b *bridge) request(ctx context.Context, method, path string, body, out any) error {
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		input = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, b.baseURL+path, input)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+b.token)
	request.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("isolated bridge HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out)
}

func (b *bridge) tab(ctx context.Context, pageURL string) (int, error) {
	var result struct {
		Success bool
		Result  struct {
			Tabs []struct {
				ID  int `json:"tabId"`
				URL string
			}
		}
	}
	if err := b.request(ctx, "POST", "/execute", map[string]any{"cmd": "list_tabs", "scope": "all"}, &result); err != nil {
		return 0, err
	}
	id, count := 0, 0
	for _, tab := range result.Result.Tabs {
		if tab.URL == pageURL {
			id, count = tab.ID, count+1
		}
	}
	if !result.Success || count != 1 || id <= 0 {
		return 0, errors.New("original bridge did not resolve exactly one fixture tab")
	}
	return id, nil
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(data []byte) (int, error) {
	if b.Len()+len(data) > 1<<20 {
		return 0, errors.New("original CLI output exceeded 1 MiB")
	}
	return b.Buffer.Write(data)
}

func (b *bridge) snapshot(ctx context.Context, tab int) ([]byte, error) {
	command := exec.CommandContext(ctx, b.binary, "snapshot", "--limit", "80", "--tab", strconv.Itoa(tab), "--url", b.baseURL, "--no-autostart", "--timeout", "10s")
	command.Env, command.Dir = b.env, b.command.Dir
	var output boundedOutput
	command.Stdout, command.Stderr = &output, io.Discard
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("original snapshot process failed: %w", err)
	}
	if !bytes.Contains(output.Bytes(), []byte("Fixture item")) || !bytes.Contains(output.Bytes(), []byte("Open item")) {
		return nil, errors.New("original snapshot output failed synthetic content assertions")
	}
	return output.Bytes(), nil
}

func (b *bridge) close() {
	_ = b.command.Process.Kill()
	_ = b.command.Wait()
}

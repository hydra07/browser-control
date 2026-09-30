package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
)

type session struct {
	g      globalOpts
	client *extbridge.Client
	state  *cliState
}

/** Small cross-invocation memory so agents can pass `e12` without repeating --document-id. */
type cliState struct {
	DocumentID string `json:"documentId,omitempty"`
	path       string
}

func newSession(g globalOpts) *session {
	st := &cliState{path: filepath.Join(extbridge.HomeDir(), "cli-state.json")}
	if data, err := os.ReadFile(st.path); err == nil {
		_ = json.Unmarshal(data, st)
	}
	return &session{g: g, state: st}
}

func (st *cliState) save() {
	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(st.path), 0o700)
	_ = os.WriteFile(st.path, data, 0o600)
}

func (s *session) bridge() (*extbridge.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	client, _, err := extbridge.NewClient(s.g.cfg)
	if err != nil {
		return nil, err
	}
	s.client = client
	return client, nil
}

// call runs one extension command and returns its result object, turning an in-band {error, hint} into a *cmdError.
func (s *session) call(cmd string, payload map[string]any) (map[string]any, error) {
	if s.g.tabID != nil {
		if _, ok := payload["tabId"]; !ok {
			payload["tabId"] = s.g.tabID
		}
	}
	raw, err := s.execute(cmd, payload)
	if err != nil {
		return nil, err
	}
	var reply struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, fmt.Errorf("bridge sent invalid JSON: %w", err)
	}
	var result map[string]any
	if err := json.Unmarshal(reply.Result, &result); err != nil || result == nil {
		// Non-object results (rare) are wrapped so every caller sees the same shape.
		var value any
		_ = json.Unmarshal(reply.Result, &value)
		return map[string]any{"value": value}, nil
	}
	if msg, ok := result["error"].(string); ok && msg != "" {
		hint, _ := result["hint"].(string)
		return nil, &cmdError{Message: msg, Hint: cliHint(hint)}
	}
	return result, nil
}

func (s *session) execute(cmd string, payload map[string]any) ([]byte, error) {
	client, err := s.bridge()
	if err != nil {
		return nil, err
	}
	data, err := client.Execute(cmd, payload)
	if err == nil {
		return data, nil
	}
	if err := s.recover(err); err != nil {
		return nil, err
	}
	return client.Execute(cmd, payload)
}

/** Handles the two recoverable startup states — bridge not running, extension not yet connected — then lets the caller retry once. */
func (s *session) recover(err error) error {
	var be *extbridge.BridgeError
	switch {
	case errors.As(err, &be) && be.NotConnected():
		return s.waitForExtension()
	case errors.As(err, &be):
		return err
	case s.g.noAutostart || !s.isLocalBridge():
		return notRunningError(err)
	}
	if err := s.startBridge(); err != nil {
		return err
	}
	return s.waitForExtension()
}

func (s *session) statusMap() (map[string]any, error) {
	client, err := s.bridge()
	if err != nil {
		return nil, err
	}
	data, err := client.Status()
	if err != nil {
		return nil, err
	}
	var status map[string]any
	if err := json.Unmarshal(data, &status); err != nil {
		return nil, err
	}
	return status, nil
}

func (s *session) waitForExtension() error {
	deadline := time.Now().Add(s.g.wait)
	for {
		status, err := s.statusMap()
		if err == nil && status["extensionConnected"] == true {
			return nil
		}
		if time.Now().After(deadline) {
			if reason := unpairedReason(status); reason != "" {
				return &cmdError{Message: reason, Hint: pairingHint}
			}
			return &cmdError{
				Message: fmt.Sprintf("extension not connected to the bridge after %s", s.g.wait),
				Hint:    "Open Chrome with the BrowserControl extension loaded, then pair it in the side panel's Settings with the token from 'browsercontrol token'. MV3 reconnect backoff can take up to 15s; raise --wait if needed.",
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func (s *session) isLocalBridge() bool {
	cfg := extbridge.NormalizeConfig(s.g.cfg)
	u, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

/** Spawns `browsercontrol serve` detached, logging to <home>/bridge.log, and waits for it to answer. */
func (s *session) startBridge() error {
	client, err := s.bridge()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cfg := extbridge.NormalizeConfig(s.g.cfg)
	logPath := filepath.Join(extbridge.HomeDir(), "bridge.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0o700)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(exe, "serve", "--host", cfg.Host, "--port", fmt.Sprint(cfg.Port))
	// Hand the already-resolved token over so the child can't pick a different one from its own lookup.
	cmd.Env = append(os.Environ(), "BROWSERCONTROL_AUTH_TOKEN="+client.Token())
	cmd.Stdout, cmd.Stderr = logFile, logFile
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("auto-start bridge: %w", err)
	}
	_ = cmd.Process.Release()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := s.statusMap(); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return &cmdError{Message: "auto-started bridge did not come up", Hint: "See " + logPath + " (port busy? another bridge with a different token?)"}
}

func notRunningError(err error) error {
	return &cmdError{
		Message: fmt.Sprintf("bridge not reachable: %v", err),
		Hint:    "Run 'browsercontrol serve' (or drop --no-autostart so commands start it automatically).",
	}
}

var mcpHint = regexp.MustCompile(`browser_\w+\(\{action:"(\w+)"[^)]*\}\)`)

var mcpActionToCLI = map[string]string{
	"snapshot": "snapshot", "list_tabs": "tabs", "navigate": "open <url>", "find": "find <query>",
	"switch_tab": "tabs switch <id>", "network_requests": "net list", "start_recording": "flow record",
	"stop_recording": "flow stop",
}

/** Rewrites the extension's MCP-style hints (browser_inspect({action:"snapshot"})) into the CLI command an agent should actually run. */
func cliHint(hint string) string {
	return mcpHint.ReplaceAllStringFunc(hint, func(m string) string {
		action := mcpHint.FindStringSubmatch(m)[1]
		if cli, ok := mcpActionToCLI[action]; ok {
			return "'browsercontrol " + cli + "'"
		}
		return "'browsercontrol " + action + "'"
	})
}

/** Moves every top-level *Base64 field into a file under dir and replaces it with the file path, so binary never reaches stdout. */
func extractBinary(result map[string]any, dir, prefix, explicitPath string) (string, error) {
	var saved string
	for key, value := range result {
		if !strings.HasSuffix(key, "Base64") {
			continue
		}
		encoded, _ := value.(string)
		delete(result, key)
		if encoded == "" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", fmt.Errorf("decode %s: %w", key, err)
		}
		path := explicitPath
		if path == "" || saved != "" {
			ext := fileExt(result, data)
			path = filepath.Join(dir, fmt.Sprintf("%s-%s%s", prefix, time.Now().Format("20060102-150405.000"), ext))
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return "", err
		}
		result[strings.TrimSuffix(key, "Base64")+"Path"] = path
		result["bytes"] = len(data)
		if saved == "" {
			saved = path
		}
	}
	return saved, nil
}

func fileExt(result map[string]any, data []byte) string {
	if format, _ := result["format"].(string); format != "" {
		if format == "jpeg" {
			return ".jpg"
		}
		return "." + format
	}
	switch {
	case len(data) > 3 && data[0] == 0x89 && data[1] == 'P':
		return ".png"
	case len(data) > 2 && data[0] == 0xFF && data[1] == 0xD8:
		return ".jpg"
	}
	return ".bin"
}

func artifactDir() string { return filepath.Join(extbridge.HomeDir(), "artifacts") }

const pairingHint = "Reload the extension in chrome://extensions: current builds auto-pair with this bridge on connect. Older builds need the output of 'browsercontrol token' pasted into side panel → Settings → Bridge pairing token."

/** Turns the bridge's lastRejection into an actionable message; "" when the extension simply hasn't dialled in. */
func unpairedReason(status map[string]any) string {
	reason, _ := status["lastRejection"].(string)
	switch {
	case reason == "":
		return ""
	case strings.Contains(reason, "not paired") || strings.Contains(reason, "token"):
		return "the extension is running but not paired with this bridge (" + reason + ")"
	default:
		return "the extension reached the bridge but was refused: " + reason
	}
}

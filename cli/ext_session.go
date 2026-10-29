package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

type session struct {
	g           globalOpts
	client      *extbridge.Client
	state       *cliState
	sessionID   string
	lock        *sessionstore.Lock
	bridgeClose func() error
}

/** Small cross-invocation memory so agents can pass `e12` without repeating --document-id. */
type cliState struct {
	DocumentID string `json:"documentId,omitempty"`
	TabID      int    `json:"tabId,omitempty"`
	store      *sessionstore.Store
	sessionID  string
	metadata   sessionstore.State
}

func newSession(g globalOpts) (*session, error) {
	id := g.sessionID
	if id == "" {
		id = os.Getenv("BROWSERCONTROL_SESSION_ID")
	}
	if id == "" {
		id = "go-cli"
	}
	store, err := sessionstore.NewStore(extbridge.HomeDir(), id)
	if err != nil {
		return nil, usagef("invalid session: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), extbridge.NormalizeConfig(g.cfg).Timeout)
	lock, err := store.Acquire(ctx)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("acquire session %q: %w", id, err)
	}
	saved, err := store.Load()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = lock.Close()
		return nil, err
	}
	// The legacy global file has no owner, so importing it could target another agent's document.
	st := &cliState{store: store, sessionID: id, DocumentID: saved.LastTarget.DocumentID, TabID: saved.LastTarget.TabID, metadata: saved}
	return &session{g: g, state: st, sessionID: id, lock: lock}, nil
}

func (s *session) close() error {
	var err error
	if s.bridgeClose != nil {
		err = s.bridgeClose()
	}
	if s.lock != nil {
		return errors.Join(err, s.lock.Close())
	}
	return err
}

func (st *cliState) save() error {
	if st.store == nil {
		return errors.New("session state store is not configured")
	}
	state := st.metadata
	state.SchemaVersion, state.ID = sessionstore.SchemaVersion, st.sessionID
	state.LastTarget = sessionstore.Target{DocumentID: st.DocumentID, TabID: st.TabID}
	return st.store.Save(state)
}

func (s *session) bridge() (*extbridge.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	client, _, err := extbridge.NewClient(s.g.cfg)
	if err != nil {
		return nil, err
	}
	if s.g.commandBridge && !s.g.noAutostart {
		if err := s.ensureCommandBridge(client); err != nil {
			return nil, err
		}
	}
	s.client = client
	return client, nil
}

// call runs one extension command and returns its result object, turning an in-band {error, hint} into a *cmdError.
func (s *session) call(cmd string, payload map[string]any) (map[string]any, error) {
	if s.g.tabID != nil && payload["newTab"] != true {
		if _, ok := payload["tabId"]; !ok {
			payload["tabId"] = s.g.tabID
		}
	}
	if s.sessionID != "" {
		if id := payload["sessionId"]; id != nil && id != s.sessionID {
			return nil, usagef("payload sessionId differs from the selected session; select --session-id on the command instead")
		}
		payload["sessionId"] = s.sessionID
	}
	raw, err := s.execute(cmd, payload)
	if err != nil {
		return nil, err
	}
	var reply struct {
		Result  json.RawMessage `json:"result"`
		Error   string          `json:"error"`
		Hint    string          `json:"hint"`
		Success *bool           `json:"success"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, unknownOutcome("bridge sent invalid JSON")
	}
	if reply.Error != "" || reply.Success != nil && !*reply.Success {
		return nil, &cmdError{Message: firstNonEmptyString(reply.Error, "bridge command failed"), Hint: cliHint(reply.Hint)}
	}
	var result map[string]any
	if err := json.Unmarshal(reply.Result, &result); err != nil || len(result) == 0 {
		return nil, unknownOutcome("bridge reply has no valid result object")
	}
	if value, exists := result["error"]; exists && value != nil {
		msg, ok := value.(string)
		if !ok || msg == "" {
			return nil, unknownOutcome("extension reply has an invalid error field")
		}
		hint, _ := result["hint"].(string)
		return result, &cmdError{Message: msg, Hint: cliHint(hint), Result: result}
	}
	if value, exists := result["success"]; exists {
		if _, valid := value.(bool); !valid {
			return nil, unknownOutcome("extension reply has an invalid success field")
		}
	}
	if result["success"] == false {
		msg := firstNonEmptyString(str(result["message"]), str(result["reason"]), "extension command failed")
		return result, &cmdError{Message: msg, Hint: cliHint(str(result["hint"])), Result: result}
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
	var be *extbridge.BridgeError
	var op *net.OpError
	safeToRetry := errors.As(err, &be) && be.NotConnected() || errors.As(err, &op) && op.Op == "dial"
	if !safeToRetry {
		return nil, executionError(err)
	}
	if err := s.recover(err); err != nil {
		return nil, err
	}
	data, err = client.Execute(cmd, payload)
	return data, executionError(err)
}

func executionError(err error) error {
	if err == nil {
		return nil
	}
	var be *extbridge.BridgeError
	if errors.As(err, &be) && (be.Status < 500 || be.NotConnected()) {
		return err
	}
	return unknownOutcome(err.Error())
}

func unknownOutcome(message string) *cmdError {
	return &cmdError{Message: "outcome unknown: " + message, Hint: "The request may have executed. Run 'browsercontrol snapshot --semantic --diff' or 'browsercontrol evidence' before deciding whether to retry; no automatic replay was performed."}
}

/** Only an explicitly running bridge with no connected extension can be waited for safely. */
func (s *session) recover(err error) error {
	var be *extbridge.BridgeError
	switch {
	case errors.As(err, &be) && be.NotConnected():
		return s.waitForExtension()
	case errors.As(err, &be):
		return err
	}
	return notRunningError(err)
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
				Hint:    "Load/reload BrowserControl in chrome://extensions and configure its local token through the service worker console as described in docs/LEGACY_EXTENSION.md. Use 'browsercontrol extension token' to obtain it. MV3 reconnect backoff can take up to 15s; raise --wait if needed.",
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

func notRunningError(err error) error {
	return &cmdError{
		Message: fmt.Sprintf("bridge not reachable: %v", err),
		Hint:    "Legacy adapter only: run 'browsercontrol extension serve' explicitly in a separate foreground terminal, then retry; direct CDP never uses this bridge.",
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
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return "", err
			}
			file, err := os.CreateTemp(dir, prefix+"-*"+ext)
			if err != nil {
				return "", err
			}
			path = file.Name()
			if err := file.Close(); err != nil {
				return "", err
			}
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
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

const pairingHint = "Reload BrowserControl in chrome://extensions and configure its local pairing token through the service worker console as described in docs/LEGACY_EXTENSION.md. Use 'browsercontrol extension token' to obtain it; automatic token disclosure is disabled by default."

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

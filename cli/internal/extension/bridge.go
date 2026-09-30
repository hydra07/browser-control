package extension

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	DefaultHost       = "127.0.0.1"
	DefaultPort       = 8765
	protocolVersion   = 2
	defaultTimeout    = 30 * time.Second
	maxHTTPBodyBytes  = 2 * 1024 * 1024
	maxWSMessageBytes = 8 * 1024 * 1024
)

type Config struct {
	Host      string
	Port      int
	BaseURL   string
	Token     string
	TokenFile string
	Timeout   time.Duration
}

type TokenInfo struct {
	Token  string `json:"token"`
	Source string `json:"source"`
}

type Server struct {
	cfg   Config
	token string

	mu               sync.Mutex
	conn             *websocket.Conn
	extensionVersion string
	// lastRejection is why the most recent extension socket was refused, so status can say "not paired" instead of just "not connected".
	lastRejection string
	pending       map[string]chan extensionResponse
}

// ErrNotConnected is returned by Execute while no authenticated extension socket is open.
var ErrNotConnected = errors.New("extension not connected")

type extensionResponse struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Data      any    `json:"data,omitempty"`
	Error     string `json:"error,omitempty"`
	Telemetry any    `json:"telemetry,omitempty"`
}

func NormalizeConfig(cfg Config) Config {
	if cfg.Host == "" {
		cfg.Host = DefaultHost
	}
	if cfg.Port <= 0 {
		cfg.Port = DefaultPort
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port)
	}
	return cfg
}

func LoadToken(cfg Config) (TokenInfo, error) {
	if value := strings.TrimSpace(cfg.Token); value != "" {
		return TokenInfo{Token: value, Source: "--token"}, nil
	}
	if env := strings.TrimSpace(os.Getenv("BROWSERCONTROL_AUTH_TOKEN")); env != "" {
		return TokenInfo{Token: env, Source: "BROWSERCONTROL_AUTH_TOKEN"}, nil
	}
	if path := firstNonEmpty(cfg.TokenFile, os.Getenv("BROWSERCONTROL_AUTH_TOKEN_FILE")); path != "" {
		token, err := readTokenFile(path)
		if err != nil {
			return TokenInfo{}, err
		}
		return TokenInfo{Token: token, Source: path}, nil
	}
	if path := findRepoTokenFile(); path != "" {
		token, err := readTokenFile(path)
		if err == nil {
			return TokenInfo{Token: token, Source: path}, nil
		}
	}
	path := filepath.Join(homeDir(), "daemon-auth-token")
	if token, err := readTokenFile(path); err == nil {
		return TokenInfo{Token: token, Source: path}, nil
	}
	token, err := generateToken()
	if err != nil {
		return TokenInfo{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return TokenInfo{}, err
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0600); err != nil {
		return TokenInfo{}, err
	}
	return TokenInfo{Token: token, Source: path}, nil
}

func NewServer(cfg Config) (*Server, TokenInfo, error) {
	cfg = NormalizeConfig(cfg)
	info, err := LoadToken(cfg)
	if err != nil {
		return nil, TokenInfo{}, err
	}
	return &Server{cfg: cfg, token: info.Token, pending: map[string]chan extensionResponse{}}, info, nil
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	server := &http.Server{Addr: fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port), Handler: s.Handler()}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	err := server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Handler is the bridge's full HTTP+WebSocket surface, exposed separately so tests can mount it on httptest.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/execute", s.handleExecute)
	mux.HandleFunc("/flows", s.handleFlows)
	mux.HandleFunc("/flows/", s.handleFlows)
	return withCORS(mux)
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if strings.ToLower(r.Header.Get("upgrade")) != "websocket" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": "browsercontrol-extension-bridge"})
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || strings.HasPrefix(origin, "chrome-extension://")
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade from %q failed: %v", r.Header.Get("Origin"), err)
		return
	}
	conn.SetReadLimit(maxWSMessageBytes)
	version, pair, err := s.authenticate(conn, r.Header.Get("Origin"))
	if err != nil {
		log.Printf("extension connection from %s rejected: %v", r.Header.Get("Origin"), err)
		s.mu.Lock()
		s.lastRejection = err.Error()
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	log.Printf("extension v%s connected", version)

	s.mu.Lock()
	old := s.conn
	s.conn = conn
	s.extensionVersion = version
	s.lastRejection = ""
	// Ack only once the socket is registered (and under the same lock Execute writes with), so a command sent right after the handshake can't see "not connected".
	ack := map[string]any{"type": "hello_ack", "protocolVersion": protocolVersion, "serverVersion": "go-cli"}
	if pair {
		ack["token"] = s.token
		log.Printf("auto-paired extension %s", r.Header.Get("Origin"))
	}
	ackErr := conn.WriteJSON(ack)
	s.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	if ackErr != nil {
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	defer func() {
		s.mu.Lock()
		if s.conn == conn {
			log.Printf("extension disconnected")
			s.conn = nil
			s.extensionVersion = ""
			// Requests sent over this socket can never be answered now; fail them instead of letting each run to its timeout.
			for id, ch := range s.pending {
				ch <- extensionResponse{ID: id, Type: "error", Error: "extension disconnected before replying"}
				close(ch)
				delete(s.pending, id)
			}
		}
		s.mu.Unlock()
		_ = conn.Close()
	}()

	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			continue
		}
		var res extensionResponse
		if err := json.Unmarshal(data, &res); err != nil || res.ID == "" {
			continue
		}
		s.mu.Lock()
		ch := s.pending[res.ID]
		delete(s.pending, res.ID)
		s.mu.Unlock()
		if ch != nil {
			ch <- res
			close(ch)
		}
	}
}

/**
 * Accepts the extension's hello. A hello with the right token is accepted as before. A hello
 * without it (fresh install, reset storage, rotated token) is auto-paired when it comes from
 * the trusted extension origin: Chrome sets Origin itself, so web pages can't claim it and other
 * extensions have other ids. The first extension to pair is pinned (trust on first use); set
 * BROWSERCONTROL_EXTENSION_ID or delete <home>/trusted-extension-id to change it. Returns
 * whether the token must be handed over in the ack.
 */
func (s *Server) authenticate(conn *websocket.Conn, origin string) (string, bool, error) {
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	messageType, data, err := conn.ReadMessage()
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		return "", false, err
	}
	if messageType != websocket.TextMessage {
		return "", false, fmt.Errorf("expected text hello")
	}
	var hello struct {
		Type            string `json:"type"`
		ProtocolVersion int    `json:"protocolVersion"`
		Role            string `json:"role"`
		Token           string `json:"token"`
		ClientVersion   string `json:"clientVersion"`
	}
	if err := json.Unmarshal(data, &hello); err != nil {
		return "", false, err
	}
	pair := false
	if hello.Type == "hello" && hello.ProtocolVersion == protocolVersion && hello.Role == "extension" && !sameToken(s.token, hello.Token) {
		if err := trustExtensionOrigin(origin); err != nil {
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authentication failed"))
			return "", false, fmt.Errorf("extension authentication failed: %w", err)
		}
		pair = true
	}
	if hello.Type != "hello" || hello.ProtocolVersion != protocolVersion || hello.Role != "extension" {
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authentication failed"))
		reason := "token mismatch (re-paste 'browsercontrol token' into the side panel)"
		switch {
		case hello.Type != "hello" || hello.Role != "extension":
			reason = "unexpected hello message"
		case hello.ProtocolVersion != protocolVersion:
			reason = fmt.Sprintf("protocol version %d, bridge speaks %d", hello.ProtocolVersion, protocolVersion)
		}
		return "", false, fmt.Errorf("extension authentication failed: %s", reason)
	}
	return hello.ClientVersion, pair, nil
}

func trustedExtensionPath() string { return filepath.Join(homeDir(), "trusted-extension-id") }

/** Pins (on first use) and checks the chrome-extension:// origin allowed to auto-pair. */
func trustExtensionOrigin(origin string) error {
	id, ok := strings.CutPrefix(origin, "chrome-extension://")
	id = strings.TrimSuffix(id, "/")
	if !ok || id == "" {
		return fmt.Errorf("token mismatch and origin %q is not an extension, so it cannot auto-pair", origin)
	}
	trusted := strings.TrimSpace(os.Getenv("BROWSERCONTROL_EXTENSION_ID"))
	if trusted == "" {
		if data, err := os.ReadFile(trustedExtensionPath()); err == nil {
			trusted = strings.TrimSpace(string(data))
		}
	}
	if trusted == "" {
		if err := os.MkdirAll(filepath.Dir(trustedExtensionPath()), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(trustedExtensionPath(), []byte(id+"\n"), 0o600); err != nil {
			return err
		}
		log.Printf("auto-pair: trusting extension %s (pinned in %s)", id, trustedExtensionPath())
		return nil
	}
	if trusted != id {
		return fmt.Errorf("token mismatch and extension %s is not the trusted one (%s); paste 'browsercontrol token' manually or update %s", id, trusted, trustedExtensionPath())
	}
	return nil
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return
	}
	s.mu.Lock()
	status := map[string]any{"extensionConnected": s.conn != nil, "version": "go-cli"}
	if s.extensionVersion != "" {
		status["extensionVersion"] = s.extensionVersion
	}
	if s.conn == nil && s.lastRejection != "" {
		status["lastRejection"] = s.lastRejection
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, status)
}

/** Lets the extension's side panel (a chrome-extension:// page) call the bridge; every route still requires the bearer token. */
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if strings.HasPrefix(origin, "chrome-extension://") {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

/** Serves the side panel's saved-flow CRUD and Run button from the same on-disk store the CLI's `flow` commands use. */
func (s *Server) handleFlows(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/flows"), "/")
	id, action, _ := strings.Cut(rest, "/")
	switch {
	case id == "" && r.Method == http.MethodGet:
		flows, err := ListFlows()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"flows": flows})
	case id == "" && r.Method == http.MethodPost:
		data, err := io.ReadAll(io.LimitReader(r.Body, maxHTTPBodyBytes))
		var flow Flow
		if err == nil {
			err = json.Unmarshal(data, &flow)
		}
		if err != nil || flow.Name == "" || len(flow.Steps) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing name or steps array"})
			return
		}
		saved, err := SaveFlow(flow)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"success": true, "flow": saved})
	case action == "" && r.Method == http.MethodGet:
		flow, err := GetFlow(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"flow": flow})
	case action == "" && r.Method == http.MethodDelete:
		if err := DeleteFlow(id); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	case action == "run" && r.Method == http.MethodPost:
		flow, err := GetFlow(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		payload := map[string]any{"steps": flow.Steps}
		if flow.Domain != "" {
			payload["domain"] = flow.Domain
		}
		result, err := s.Execute("run_flow", payload, s.cfg.Timeout)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
	}
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return
	}
	body, err := readJSONBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	cmd, _ := body["cmd"].(string)
	if strings.TrimSpace(cmd) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing cmd"})
		return
	}
	timeout := s.cfg.Timeout
	if raw, ok := body["timeoutMs"]; ok {
		if ms := numberToInt(raw); ms > 0 {
			timeout = time.Duration(ms) * time.Millisecond
		}
		delete(body, "timeoutMs")
	}
	result, err := s.Execute(cmd, body, timeout)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, ErrNotConnected) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": result})
}

func (s *Server) Execute(cmd string, payload map[string]any, timeout time.Duration) (any, error) {
	s.mu.Lock()
	conn := s.conn
	if conn == nil {
		s.mu.Unlock()
		return nil, ErrNotConnected
	}
	id, err := requestID()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	ch := make(chan extensionResponse, 1)
	s.pending[id] = ch
	msg := map[string]any{"id": id, "cmd": cmd, "sessionId": "go-cli"}
	for k, v := range payload {
		if k != "cmd" {
			msg[k] = v
		}
	}
	err = conn.WriteJSON(msg)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case res := <-ch:
		if res.Type == "error" {
			return nil, errors.New(res.Error)
		}
		return res.Data, nil
	case <-time.After(timeout):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, fmt.Errorf("timeout after %s waiting for extension to finish %q", timeout, cmd)
	}
}

func (s *Server) authorized(r *http.Request) bool {
	value := r.Header.Get("Authorization")
	parts := strings.SplitN(value, " ", 2)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		return sameToken(s.token, strings.TrimSpace(parts[1]))
	}
	return false
}

func readJSONBody(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	limited := io.LimitReader(r.Body, maxHTTPBodyBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(data) > maxHTTPBodyBytes {
		return nil, fmt.Errorf("request body exceeds %d bytes", maxHTTPBodyBytes)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("request body must be valid JSON: %w", err)
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func readTokenFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 32 {
		return "", fmt.Errorf("token in %s is too short", path)
	}
	return token, nil
}

/** Looks for the repo's data/daemon-auth-token above the cwd, then above the binary, so agents can call the exe from anywhere without --token-file. */
func findRepoTokenFile() string {
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		starts = append(starts, filepath.Dir(exe))
	}
	for _, dir := range starts {
		for i := 0; i < 8; i++ {
			candidate := filepath.Join(dir, "data", "daemon-auth-token")
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// HomeDir is the per-user state directory (token fallback, CLI state, bridge log).
func HomeDir() string { return homeDir() }

func homeDir() string {
	if value := strings.TrimSpace(os.Getenv("BROWSERCONTROL_HOME")); value != "" {
		return value
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".browsercontrol")
	}
	return ".browsercontrol"
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func requestID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func sameToken(expected, candidate string) bool {
	expectedHash := sha256.Sum256([]byte(expected))
	candidateHash := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(expectedHash[:], candidateHash[:]) == 1
}

func numberToInt(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		i, _ := strconv.Atoi(v.String())
		return i
	case string:
		i, _ := strconv.Atoi(v)
		return i
	default:
		return 0
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func marshalBody(value any) (*bytes.Reader, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(data), nil
}

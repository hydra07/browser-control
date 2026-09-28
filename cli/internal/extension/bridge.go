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

	mu      sync.Mutex
	conn    *websocket.Conn
	pending map[string]chan extensionResponse
}

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
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/execute", s.handleExecute)
	server := &http.Server{Addr: fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port), Handler: mux}
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
		return
	}
	conn.SetReadLimit(maxWSMessageBytes)
	if err := s.authenticate(conn); err != nil {
		_ = conn.Close()
		return
	}

	s.mu.Lock()
	old := s.conn
	s.conn = conn
	s.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	defer func() {
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
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

func (s *Server) authenticate(conn *websocket.Conn) error {
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	messageType, data, err := conn.ReadMessage()
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		return err
	}
	if messageType != websocket.TextMessage {
		return fmt.Errorf("expected text hello")
	}
	var hello struct {
		Type            string `json:"type"`
		ProtocolVersion int    `json:"protocolVersion"`
		Role            string `json:"role"`
		Token           string `json:"token"`
	}
	if err := json.Unmarshal(data, &hello); err != nil {
		return err
	}
	if hello.Type != "hello" || hello.ProtocolVersion != protocolVersion || hello.Role != "extension" || !sameToken(s.token, hello.Token) {
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "authentication failed"))
		return fmt.Errorf("extension authentication failed")
	}
	return conn.WriteJSON(map[string]any{"type": "hello_ack", "protocolVersion": protocolVersion, "serverVersion": "go-cli"})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return
	}
	s.mu.Lock()
	connected := s.conn != nil
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"extensionConnected": connected, "version": "go-cli"})
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
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
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": result})
}

func (s *Server) Execute(cmd string, payload map[string]any, timeout time.Duration) (any, error) {
	s.mu.Lock()
	conn := s.conn
	if conn == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("extension not connected; open Chrome with BrowserControl extension loaded and paired")
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
			return nil, fmt.Errorf(res.Error)
		}
		return res.Data, nil
	case <-time.After(timeout):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, fmt.Errorf("timeout waiting for extension")
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

func findRepoTokenFile() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(wd, "data", "daemon-auth-token")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			break
		}
		wd = parent
	}
	return ""
}

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

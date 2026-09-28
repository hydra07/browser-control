package daemon

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const DefaultPort = 8765

const authTokenEnv = "BROWSERCONTROL_AUTH_TOKEN"

type Config struct {
	BaseURL   string
	Port      int
	Token     string
	TokenFile string
	Timeout   time.Duration
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		port := cfg.Port
		if port <= 0 {
			port = DefaultPort
		}
		baseURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("invalid daemon URL %q: %w", baseURL, err)
	}

	token, err := resolveToken(cfg)
	if err != nil {
		return nil, err
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: timeout},
	}, nil
}

func resolveToken(cfg Config) (string, error) {
	if token := strings.TrimSpace(cfg.Token); token != "" {
		return token, nil
	}
	if token := strings.TrimSpace(os.Getenv(authTokenEnv)); token != "" {
		return token, nil
	}
	if cfg.TokenFile != "" {
		return readTokenFile(cfg.TokenFile)
	}
	if path, ok := findAuthTokenFile(); ok {
		return readTokenFile(path)
	}
	return "", errors.New("daemon auth token not found; pass --token, --token-file, set BROWSERCONTROL_AUTH_TOKEN, or run from a checkout with data/daemon-auth-token")
}

func readTokenFile(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read token file %q: %w", path, err)
	}
	token := strings.TrimSpace(string(bytes))
	if token == "" {
		return "", fmt.Errorf("token file %q is empty", path)
	}
	return token, nil
}

func findAuthTokenFile() (string, bool) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", false
	}
	candidates := []string{}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		candidates = append(candidates,
			filepath.Join(dir, "data", "daemon-auth-token"),
			filepath.Join(dir, "..", "data", "daemon-auth-token"),
		)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "data", "daemon-auth-token"),
			filepath.Join(exeDir, "..", "data", "daemon-auth-token"),
		)
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, true
		}
	}
	return "", false
}

func (c *Client) Request(method, path string, body any) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("encode request body: %w", err)
		}
		reader = bytes.NewReader(payload)
	}

	endpoint := c.baseURL + normalizedPath(path)
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json, text/event-stream, text/plain")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, resp.StatusCode, readErr
	}
	if resp.StatusCode >= 400 {
		return data, resp.StatusCode, fmt.Errorf("daemon returned HTTP %d: %s", resp.StatusCode, compactBody(data))
	}
	return data, resp.StatusCode, nil
}

func normalizedPath(path string) string {
	if path == "" {
		return "/"
	}
	if strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}

func compactBody(data []byte) string {
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "<empty response>"
	}
	if len(text) > 500 {
		return text[:500] + "…"
	}
	return text
}

func PrintJSONBytes(data []byte) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		fmt.Println(string(data))
		return
	}
	pretty, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Println(string(data))
		return
	}
	fmt.Println(string(pretty))
}

func escapePathPart(value string) string {
	return url.PathEscape(value)
}

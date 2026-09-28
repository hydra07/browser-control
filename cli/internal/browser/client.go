package browser

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/go-rod/rod"
)

const DefaultCDPPort = 9222

type Config struct {
	Port     int
	Headless bool
	DataDir  string
}

func DefaultConfig() Config {
	return Config{Port: DefaultCDPPort, Headless: false, DataDir: filepath.Join(BrowserControlDir(), "profile")}
}

// FindChromePath discovers a local Chrome/Chromium/Edge installation on Windows/macOS/Linux.
func FindChromePath() string {
	candidates := []string{
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return ""
}

// IsCDPAvailable checks if Chrome CDP is actively listening on the target port.
func IsCDPAvailable(port int) bool {
	client := http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func getWebSocketDebuggerURL(port int) (string, error) {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var data struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	if data.WebSocketDebuggerURL == "" {
		return "", fmt.Errorf("webSocketDebuggerUrl not found in /json/version")
	}
	return data.WebSocketDebuggerURL, nil
}

func launchChromeDirect(cfg Config) error {
	bin := FindChromePath()
	if bin == "" {
		return fmt.Errorf("could not find Chrome, Chromium, or Edge on system")
	}
	if cfg.DataDir == "" {
		cfg.DataDir = filepath.Join(BrowserControlDir(), "profile")
	}
	args := []string{
		fmt.Sprintf("--remote-debugging-port=%d", cfg.Port),
		fmt.Sprintf("--user-data-dir=%s", cfg.DataDir),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
	}
	if cfg.Headless {
		args = append(args, "--headless=new", "--disable-gpu")
	}
	if runtime.GOOS == "linux" && os.Geteuid() == 0 {
		args = append(args, "--no-sandbox")
	}
	cmd := exec.Command(bin, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start Chrome: %w", err)
	}
	deadline := time.Now().Add(7 * time.Second)
	for time.Now().Before(deadline) {
		if IsCDPAvailable(cfg.Port) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for Chrome CDP on port %d", cfg.Port)
}

// GetBrowser connects to an existing Chrome instance or launches one if unavailable.
func GetBrowser(cfg Config) (*rod.Browser, error) {
	if cfg.Port <= 0 {
		cfg.Port = DefaultCDPPort
	}
	if !IsCDPAvailable(cfg.Port) {
		_ = os.MkdirAll(cfg.DataDir, 0755)
		if err := launchChromeDirect(cfg); err != nil {
			return nil, err
		}
	}
	wsURL, err := getWebSocketDebuggerURL(cfg.Port)
	if err != nil {
		return nil, err
	}
	b := rod.New().ControlURL(wsURL)
	if err := b.Connect(); err != nil {
		return nil, fmt.Errorf("failed to connect to Chrome CDP at %s: %w", wsURL, err)
	}
	return b, nil
}

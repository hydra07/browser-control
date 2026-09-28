package browser

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

const DefaultCDPPort = 9222

type Config struct {
	Port     int
	Headless bool
	DataDir  string
}

func DefaultConfig() Config {
	dataDir := filepath.Join(os.Getenv("USERPROFILE"), ".browsercontrol", "profile")
	return Config{
		Port:     DefaultCDPPort,
		Headless: false,
		DataDir:  dataDir,
	}
}

// FindChromePath discovers the local installation of Chrome or Edge on Windows/macOS/Linux.
func FindChromePath() string {
	candidates := []string{
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		"/usr/bin/google-chrome",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if path, err := exec.LookPath("chrome"); err == nil {
		return path
	}
	if path, err := exec.LookPath("google-chrome"); err == nil {
		return path
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
		return fmt.Errorf("could not find chrome.exe or msedge.exe on system")
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
		args = append(args, "--headless=new")
	}

	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start Chrome: %w", err)
	}

	// Wait up to 5 seconds for port to open
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if IsCDPAvailable(cfg.Port) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for Chrome CDP on port %d", cfg.Port)
}

// GetBrowser connects to an existing Chrome instance or launches one if not available.
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
		wsURL, _ = launcher.ResolveURL(fmt.Sprintf("http://127.0.0.1:%d", cfg.Port))
	}

	b := rod.New().ControlURL(wsURL)
	if err := b.Connect(); err != nil {
		return nil, fmt.Errorf("failed to connect to Chrome CDP at %s: %w", wsURL, err)
	}
	return b, nil
}

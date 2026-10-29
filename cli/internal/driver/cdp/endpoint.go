package cdp

import (
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var browserPath = regexp.MustCompile(`^/devtools/browser/[A-Za-z0-9_-]+$`)

// Discover reads the browser's current ephemeral endpoint instead of trusting a saved port.
func Discover(profile string) (string, error) {
	file, err := os.Open(filepath.Join(profile, "DevToolsActivePort"))
	if err != nil {
		return "", fmt.Errorf("discover Chrome endpoint: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", err
	}
	lines := strings.Fields(string(data))
	if len(data) > 4096 || len(lines) != 2 {
		return "", fmt.Errorf("invalid DevToolsActivePort")
	}
	endpoint := "ws://" + net.JoinHostPort("127.0.0.1", lines[0]) + lines[1]
	if err := ValidateEndpoint(endpoint); err != nil {
		return "", err
	}
	return endpoint, nil
}

// ValidateEndpoint accepts only explicit loopback browser WebSockets without credentials.
func ValidateEndpoint(endpoint string) error {
	return validateEndpoint(endpoint, false)
}

func validateEndpoint(endpoint string, allowRemote bool) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("invalid Chrome endpoint")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || (u.Scheme != "ws" && u.Scheme != "wss") ||
		(!net.ParseIP(u.Hostname()).IsLoopback() && !allowRemote) || u.Hostname() == "" || u.User != nil || u.RawQuery != "" ||
		u.Fragment != "" || u.RawPath != "" || !browserPath.MatchString(u.Path) {
		return fmt.Errorf("Chrome endpoint must be a ws/wss browser URL with an explicit port and no credentials/query; remote endpoints require explicit opt-in")
	}
	return nil
}

package cdp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverUsesEphemeralLoopbackEndpoint(t *testing.T) {
	profile := t.TempDir()
	path := filepath.Join(profile, "DevToolsActivePort")
	for _, data := range []string{"49321\n/devtools/browser/uuid-1\n", "49322\n/devtools/browser/uuid-2\n"} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		endpoint, err := Discover(profile)
		if err != nil || !strings.HasPrefix(endpoint, "ws://127.0.0.1:"+strings.Split(data, "\n")[0]+"/") {
			t.Fatalf("%q: %v", endpoint, err)
		}
	}
	for _, data := range []string{"", "9222", "0\n/devtools/browser/id", "65536\n/devtools/browser/id", "80\n//evil.test/", "80\n/devtools/browser/../../x", strings.Repeat("x", 4097)} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Discover(profile); err == nil {
			t.Fatalf("accepted %q", data)
		}
	}
}

func TestEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1:80/devtools/browser/id", "ws://192.0.2.1:80/devtools/browser/id", "ws://example.com:80/devtools/browser/id", "ws://user:pass@127.0.0.1:80/devtools/browser/id", "ws://127.0.0.1:80/devtools/browser/id?token=x", "ws://127.0.0.1/devtools/browser/id", "ws://127.0.0.1:80/devtools/page/id"} {
		if err := ValidateEndpoint(endpoint); err == nil {
			t.Fatalf("accepted %q", endpoint)
		}
	}
	for _, endpoint := range []string{"ws://127.0.0.1:49321/devtools/browser/abc-1", "ws://[::1]:49321/devtools/browser/abc-1"} {
		if err := ValidateEndpoint(endpoint); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRemoteEndpointRequiresExplicitOptIn(t *testing.T) {
	endpoint := "wss://example.test:443/devtools/browser/abc-1"
	if err := validateEndpoint(endpoint, false); err == nil {
		t.Fatal("remote endpoint enabled by default")
	}
	if err := validateEndpoint(endpoint, true); err != nil {
		t.Fatal(err)
	}
	if err := validateEndpoint("wss://user:secret@example.test:443/devtools/browser/abc-1", true); err == nil {
		t.Fatal("credential-bearing endpoint accepted")
	}
}

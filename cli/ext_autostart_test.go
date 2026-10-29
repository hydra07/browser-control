package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	// The pre-refactor spawn path must not recursively run this entire test binary as a daemon.
	if marker := os.Getenv("BROWSERCONTROL_TEST_AUTOSTART_MARKER"); marker != "" && os.Getenv("BROWSERCONTROL_CLI_JSON_CHILD") == "1" && len(os.Args) > 1 && os.Args[1] == "serve" {
		if err := os.WriteFile(marker, []byte("unexpected detached serve child"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestCLIConnectionFailureNeverStartsDetachedBridge(t *testing.T) {
	for _, command := range [][]string{{"status"}, {"exec", "peek_screen"}, {"status", "--no-autostart=false"}} {
		t.Run(strings.Join(command, "_"), func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			_ = listener.Close()
			marker := filepath.Join(t.TempDir(), "unexpected-autostart")
			t.Setenv("BROWSERCONTROL_TEST_AUTOSTART_MARKER", marker)
			args := []string{"--json", "--url", fmt.Sprintf("http://127.0.0.1:%d", port), "--port", strconv.Itoa(port), "--timeout", "100ms", "--token", "0123456789abcdef0123456789abcdef"}
			code, stdout, stderr := runCLIProcess(t, append(args, command...)...)
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("CLI spawned a detached bridge: %v", err)
			}
			if code != 1 {
				t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
			}
			result := singleJSONResult(t, stdout)
			if !strings.Contains(result["hint"].(string), "serve") || strings.Contains(result["hint"].(string), "automatically") {
				t.Fatalf("misleading connection recovery hint: %+v", result)
			}
		})
	}
}

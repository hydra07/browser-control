package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFixtureGuardExitCodesAndPrivateDiagnostics(t *testing.T) {
	for _, test := range []struct {
		name, path, content string
		code                int
	}{
		{"public", "fixtures/public/orders.json", `{"name":"Mai Nguyen","email":"mai@example.test","orderId":"ORD-42"}`, 0},
		{"credential", "fixtures/public/orders.json", `{"password":"synthetic-sensitive-value"}`, 1},
		{"private", "fixtures/private/orders.json", `{"name":"Mai Nguyen"}`, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			for _, args := range [][]string{{"init", "-q"}} {
				if output, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
					t.Fatalf("git setup: %v %s", err, output)
				}
			}
			file := filepath.Join(root, filepath.FromSlash(test.path))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte(test.content), 0600); err != nil {
				t.Fatal(err)
			}
			if output, err := exec.Command("git", "-C", root, "add", "-f", "--", test.path).CombinedOutput(); err != nil {
				t.Fatalf("stage fixture: %v %s", err, output)
			}
			var stdout, stderr bytes.Buffer
			code := run(context.Background(), []string{"-root", root}, &stdout, &stderr)
			if code != test.code {
				t.Fatalf("exit=%d stdout=%s stderr=%s", code, &stdout, &stderr)
			}
			if strings.Contains(stdout.String()+stderr.String(), "synthetic-sensitive-value") {
				t.Fatal("diagnostics leaked secret data")
			}
			if code == 1 && stdout.Len() != 0 {
				t.Fatal("failed guard printed a success result")
			}
		})
	}
}

func TestFixtureGuardHelpUsageAndMissingRepository(t *testing.T) {
	for _, test := range []struct {
		args []string
		code int
	}{{[]string{"-help"}, 0}, {[]string{"-unknown"}, 2}, {[]string{"extra"}, 2}, {[]string{"-root", t.TempDir()}, 1}} {
		var stdout, stderr bytes.Buffer
		if code := run(context.Background(), test.args, &stdout, &stderr); code != test.code {
			t.Fatalf("exit=%d expected=%d", code, test.code)
		}
	}
}

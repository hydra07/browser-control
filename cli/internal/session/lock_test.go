package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProcessLockSurvivesFileAndReleasesAfterKill(t *testing.T) {
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestSessionLockChild$")
	command.Env = append(os.Environ(), "BROWSERCONTROL_LOCK_TEST_ROOT="+root)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		if !waited {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
		} else {
			ready <- "no child readiness"
		}
	}()
	select {
	case line := <-ready:
		if line != "LOCKED" {
			t.Fatal(line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lock child did not become ready")
	}
	store, _ := NewStore(root, "agent")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	if _, err := store.Acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("concurrent process acquired lock: %v", err)
	}
	cancel()
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	waited = true
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	lock, err := store.Acquire(ctx)
	if err != nil {
		t.Fatalf("orphaned OS lock was not released: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "sessions", "agent", "session.lock"))
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		PID      int
		Hostname string
	}
	if err := json.Unmarshal(data, &metadata); err != nil || metadata.PID != os.Getpid() || metadata.Hostname == "" {
		t.Fatalf("lock metadata: %s, %v", data, err)
	}
}

func TestSessionLockChild(t *testing.T) {
	root := os.Getenv("BROWSERCONTROL_LOCK_TEST_ROOT")
	if root == "" {
		t.Skip("subprocess helper")
	}
	store, err := NewStore(root, "agent")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	lock, err := store.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	fmt.Println("LOCKED")
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestProcessLockCancellationAndIndependentSessions(t *testing.T) {
	root := t.TempDir()
	a, _ := NewStore(root, "a")
	b, _ := NewStore(root, "b")
	lock, err := a.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	other, err := b.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.Acquire(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait: %v", err)
	}
}

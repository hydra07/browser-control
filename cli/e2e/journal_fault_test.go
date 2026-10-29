package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestChromeJournalRetainsIntentAcrossKilledInputProcess(t *testing.T) {
	for _, point := range []string{"before_dispatch", "after_dispatch", "after_outcome"} {
		t.Run(point, func(t *testing.T) {
			h := startChrome(t)
			page := h.open(t, "/controls.html")
			page.eval(t, `document.querySelector('button').focus(); true`, new(bool))
			home := t.TempDir()
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(executable, "-test.run=^TestJournalInputChild$")
			command.Env = append(os.Environ(), "BC_JOURNAL_CHILD_POINT="+point, "BC_JOURNAL_CHILD_HOME="+home, "BC_JOURNAL_CHILD_PROFILE="+h.profile, "BC_JOURNAL_CHILD_TARGET="+page.targetID)
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdin, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			var stderr bytes.Buffer
			command.Stderr = &stderr
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
				for scanner.Scan() {
					if scanner.Text() == "PAUSED" {
						ready <- "PAUSED"
						return
					}
				}
				ready <- "child exited before pause"
			}()
			select {
			case line := <-ready:
				if line != "PAUSED" {
					t.Fatalf("%s: %s", line, stderr.String())
				}
			case <-time.After(15 * time.Second):
				t.Fatal("input child did not reach fault point")
			}
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			_ = command.Wait()
			waited = true
			store, err := session.NewStore(home, "fault-agent")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			lock, err := store.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			journal, err := store.OpenJournal(lock)
			if err != nil {
				t.Fatal(err)
			}
			records, err := journal.Records()
			if err != nil || len(records) != 1 {
				t.Fatalf("action disappeared after kill: %+v %v", records, err)
			}
			uncertain, err := journal.Uncertain()
			if err != nil {
				t.Fatal(err)
			}
			wantPending := point != "after_outcome"
			if (len(uncertain) == 1) != wantPending {
				t.Fatalf("wrong recovery at %s: %+v", point, records)
			}
			var status string
			page.eval(t, `document.querySelector('[role="status"]').textContent`, &status)
			if (status != "Not saved") != (point != "before_dispatch") {
				t.Fatalf("wrong physical effect at %s: %s", point, status)
			}
			if wantPending {
				called := false
				_, err := journal.Execute(ctx, session.ActionScope{BrowserID: "fixture-browser", TargetID: page.targetID}, driver.Press, func(context.Context) (driver.ActionResult, error) { called = true; return driver.ActionResult{}, nil })
				if !errors.Is(err, session.ErrPendingAction) || called {
					t.Fatalf("unsafe replay after process death: %v called=%t", err, called)
				}
			}
		})
	}
}

func TestJournalInputChild(t *testing.T) {
	point := os.Getenv("BC_JOURNAL_CHILD_POINT")
	if point == "" {
		t.Skip("owned test-process helper")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	store, err := session.NewStore(os.Getenv("BC_JOURNAL_CHILD_HOME"), "fault-agent")
	if err != nil {
		t.Fatal(err)
	}
	lock, err := store.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	journal, err := store.OpenJournal(lock)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := cdp.Discover(os.Getenv("BC_JOURNAL_CHILD_PROFILE"))
	if err != nil {
		t.Fatal(err)
	}
	client, err := cdp.Connect(ctx, endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	targetID := os.Getenv("BC_JOURNAL_CHILD_TARGET")
	target, err := client.Attach(ctx, targetID)
	if err != nil {
		t.Fatal(err)
	}
	pause := func() { fmt.Println("PAUSED"); _, _ = io.Copy(io.Discard, os.Stdin) }
	result, err := journal.Execute(ctx, session.ActionScope{BrowserID: "fixture-browser", TargetID: targetID}, driver.Press, func(actionCtx context.Context) (driver.ActionResult, error) {
		if point == "before_dispatch" {
			pause()
		}
		result, err := target.Press(actionCtx, []driver.Key{{Key: "Enter", Code: "Enter", VirtualKey: 13}})
		if err == nil && point == "after_dispatch" {
			pause()
		}
		return result, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if point == "after_outcome" {
		pause()
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(data))
}

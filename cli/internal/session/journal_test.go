package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func journalForTest(t *testing.T, root, id string) (*Store, *Lock, *Journal) {
	t.Helper()
	store, err := NewStore(root, id)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := store.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	journal, err := store.OpenJournal(lock)
	if err != nil {
		t.Fatal(err)
	}
	return store, lock, journal
}

func acknowledgedResult(kind driver.ActionKind) driver.ActionResult {
	result := driver.NewAction(kind)
	now := time.Now().UnixMilli()
	result.Status = driver.Completed
	result.Dispatched = true
	result.InputState = driver.Acknowledged
	result.Acknowledged = true
	result.DispatchedAt = &now
	result.FinishedAt = now
	return result
}

func TestJournalFsyncsIntentBeforeDispatchAndPreservesOutcome(t *testing.T) {
	root := t.TempDir()
	_, lock, journal := journalForTest(t, root, "agent")
	var dispatched bool
	result, err := journal.Execute(context.Background(), ActionScope{BrowserID: "browser-fixture", TargetID: "target-fixture"}, driver.InsertText, func(ctx context.Context) (driver.ActionResult, error) {
		data, err := os.ReadFile(filepath.Join(root, "sessions", "agent", "actions.jsonl"))
		if err != nil || !strings.Contains(string(data), `"status":"dispatch_unknown"`) {
			t.Fatalf("input before durable intent: %s %v", data, err)
		}
		dispatched = true
		return acknowledgedResult(driver.InsertText), nil
	})
	if err != nil || !dispatched || result.Status != driver.Completed {
		t.Fatalf("execute: %+v %v", result, err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, reopened := journalForTest(t, root, "agent")
	records, err := reopened.Records()
	if err != nil || len(records) != 1 || records[0].Outcome == nil || records[0].Outcome.ActionID != result.ActionID {
		t.Fatalf("recovery: %+v %v", records, err)
	}
	data, err := os.ReadFile(filepath.Join(root, "sessions", "agent", "actions.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "\n") != 2 {
		t.Fatalf("bad journal: %s", data)
	}
}

func TestJournalCancellationAfterIntentStillCommitsCancelledOutcome(t *testing.T) {
	_, _, journal := journalForTest(t, t.TempDir(), "agent")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	syncs := 0
	journal.syncFile = func(file *os.File) error {
		syncs++
		err := file.Sync()
		if syncs == 1 {
			cancel()
		}
		return err
	}
	called := false
	result, err := journal.Execute(ctx, ActionScope{BrowserID: "b", TargetID: "t"}, driver.Click, func(context.Context) (driver.ActionResult, error) {
		called = true
		return acknowledgedResult(driver.Click), nil
	})
	if !errors.Is(err, context.Canceled) || called || result.Status != driver.Cancelled || result.Dispatched || result.Validate() != nil {
		t.Fatalf("cancel at J1: %+v %v called=%t", result, err, called)
	}
	uncertain, err := journal.Uncertain()
	if err != nil || len(uncertain) != 0 || syncs != 2 {
		t.Fatalf("cancelled outcome was not committed: %v syncs=%d", err, syncs)
	}
}

func TestJournalOutcomeFailureRetainsIntentAndNeverRepeatsDispatch(t *testing.T) {
	root := t.TempDir()
	_, lock, journal := journalForTest(t, root, "agent")
	syncs, calls := 0, 0
	journal.syncFile = func(file *os.File) error {
		syncs++
		if syncs == 2 {
			if err := os.Truncate(file.Name(), journal.size); err != nil {
				t.Fatalf("fault injection failed: %v", err)
			}
			return errors.New("fixture disk failure at J2")
		}
		return file.Sync()
	}
	dispatch := func(context.Context) (driver.ActionResult, error) {
		calls++
		return acknowledgedResult(driver.Click), nil
	}
	result, err := journal.Execute(context.Background(), ActionScope{BrowserID: "b", TargetID: "t"}, driver.Click, dispatch)
	if err == nil || !strings.Contains(err.Error(), "do not repeat input") || result.Status != driver.Completed || !result.Dispatched {
		t.Fatalf("J2 failure misreported dispatch: %+v %v", result, err)
	}
	_, err = journal.Execute(context.Background(), ActionScope{BrowserID: "b", TargetID: "t"}, driver.Click, dispatch)
	if err == nil || calls != 1 {
		t.Fatalf("J2 failure replayed: calls=%d error=%v", calls, err)
	}
	_ = lock.Close()
	_, _, reopened := journalForTest(t, root, "agent")
	uncertain, err := reopened.Uncertain()
	if err != nil || len(uncertain) != 1 || uncertain[0].ActionID != result.ActionID {
		t.Fatalf("J1 disappeared after failed J2: %+v %v", uncertain, err)
	}
}

func TestJournalPersistsMetadataWithoutInputOrErrorText(t *testing.T) {
	root := t.TempDir()
	_, _, journal := journalForTest(t, root, "agent")
	secret := "synthetic-password-that-must-not-be-in-the-journal"
	_, err := journal.Execute(context.Background(), ActionScope{BrowserID: "b", TargetID: "t"}, driver.InsertText, func(context.Context) (driver.ActionResult, error) {
		return acknowledgedResult(driver.InsertText), errors.New(secret)
	})
	if err == nil {
		t.Fatal("dispatch error lost")
	}
	data, err := os.ReadFile(filepath.Join(root, "sessions", "agent", "actions.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), secret) {
		t.Fatal("error text persisted in action journal")
	}
}

func TestJournalRejectsUnrelatedOrDuplicateOutcome(t *testing.T) {
	_, _, journal := journalForTest(t, t.TempDir(), "agent")
	action := driver.NewAction(driver.Click)
	record, err := journal.Begin(context.Background(), ActionIntent{ActionID: action.ActionID, Kind: action.Kind, StartedAt: action.StartedAt, Scope: ActionScope{BrowserID: "b", TargetID: "t"}})
	if err != nil {
		t.Fatal(err)
	}
	result := acknowledgedResult(driver.Click)
	if err := journal.Finish(record.Seq, result); err == nil {
		t.Fatal("another action resolved the pending intent")
	}
	result.ActionID = action.ActionID
	result.StartedAt = action.StartedAt
	if err := journal.Finish(record.Seq, result); err != nil {
		t.Fatal(err)
	}
	if err := journal.Finish(record.Seq, result); err == nil {
		t.Fatal("duplicate outcome accepted")
	}
}

func TestJournalRefusesDispatchIfIntentCannotBeSynced(t *testing.T) {
	_, _, journal := journalForTest(t, t.TempDir(), "agent")
	journal.syncFile = func(*os.File) error { return errors.New("fixture fsync failure") }
	called := false
	_, err := journal.Execute(context.Background(), ActionScope{BrowserID: "b", TargetID: "t"}, driver.Click, func(context.Context) (driver.ActionResult, error) {
		called = true
		return acknowledgedResult(driver.Click), nil
	})
	if err == nil || called {
		t.Fatalf("input escaped unsynced intent: called=%t error=%v", called, err)
	}
}

func TestJournalRecoversTornOutcomeAndBlocksNewMutation(t *testing.T) {
	root := t.TempDir()
	_, lock, journal := journalForTest(t, root, "agent")
	action := driver.NewAction(driver.Click)
	if _, err := journal.Begin(context.Background(), ActionIntent{ActionID: action.ActionID, Kind: action.Kind, StartedAt: action.StartedAt, Scope: ActionScope{BrowserID: "b", TargetID: "t"}}); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "sessions", "agent", "actions.jsonl")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString(`{"schemaVersion":1,"event":"outcome"`)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	_, _, reopened := journalForTest(t, root, "agent")
	uncertain, err := reopened.Uncertain()
	if err != nil || len(uncertain) != 1 || uncertain[0].ActionID != action.ActionID {
		t.Fatalf("lost intent after torn outcome: %+v %v", uncertain, err)
	}
	called := false
	_, err = reopened.Execute(context.Background(), ActionScope{BrowserID: "b", TargetID: "t"}, driver.Click, func(context.Context) (driver.ActionResult, error) {
		called = true
		return acknowledgedResult(driver.Click), nil
	})
	if !errors.Is(err, ErrPendingAction) || called {
		t.Fatalf("uncertain mutation replayed: %v called=%t", err, called)
	}
}

func TestJournalRequiresCorrectLiveSessionLock(t *testing.T) {
	store, lock, _ := journalForTest(t, t.TempDir(), "a")
	other, _ := NewStore(store.root, "b")
	if _, err := other.OpenJournal(lock); err == nil {
		t.Fatal("another session's lock accepted")
	}
	_ = lock.Close()
	if _, err := store.OpenJournal(lock); err == nil {
		t.Fatal("released lock accepted")
	}
}

func TestJournalExecutionClaimsTabAcrossSessions(t *testing.T) {
	root := t.TempDir()
	_, _, first := journalForTest(t, root, "a")
	_, _, second := journalForTest(t, root, "b")
	scope := ActionScope{BrowserID: "b", TargetID: "t"}
	_, err := first.Execute(context.Background(), scope, driver.Click, func(context.Context) (driver.ActionResult, error) { return acknowledgedResult(driver.Click), nil })
	if err != nil {
		t.Fatal(err)
	}
	called := false
	result, err := second.Execute(context.Background(), scope, driver.Click, func(context.Context) (driver.ActionResult, error) {
		called = true
		return acknowledgedResult(driver.Click), nil
	})
	var owned *TabOwnedError
	if !errors.As(err, &owned) || owned.Owner != "a" || called || result.Status != driver.Blocked || result.Dispatched {
		t.Fatalf("tab owner bypassed: %+v %v called=%t", result, err, called)
	}
}

func TestJournalRejectsCompleteCorruptionWithoutDiscardingIt(t *testing.T) {
	root := t.TempDir()
	store, lock, _ := journalForTest(t, root, "agent")
	_ = lock.Close()
	path := filepath.Join(root, "sessions", "agent", "actions.jsonl")
	if err := os.WriteFile(path, []byte("{broken}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, err := store.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err := store.OpenJournal(lock); err == nil {
		t.Fatal("corrupt committed line silently discarded")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "{broken}\n" {
		t.Fatal("corrupt journal changed")
	}
}

func TestJournalReadBudgetsAndOwnerAreEnforced(t *testing.T) {
	for _, mode := range []string{"wrong-owner", "future-version", "wrong-sequence", "oversized-record", "oversized-file"} {
		t.Run(mode, func(t *testing.T) {
			store, lock, journal := journalForTest(t, t.TempDir(), "agent")
			_ = lock.Close()
			action := driver.NewAction(driver.Click)
			wire := journalWire{SchemaVersion: 1, SessionID: "agent", Seq: 1, Event: journalIntent, Status: "dispatch_unknown", Intent: &ActionIntent{ActionID: action.ActionID, Kind: action.Kind, StartedAt: action.StartedAt, Scope: ActionScope{BrowserID: "b", TargetID: "t"}}}
			switch mode {
			case "wrong-owner":
				wire.SessionID = "other"
			case "future-version":
				wire.SchemaVersion = 2
			case "wrong-sequence":
				wire.Seq = 7
			}
			data, err := json.Marshal(wire)
			if err != nil {
				t.Fatal(err)
			}
			data = append(data, '\n')
			if mode == "oversized-record" {
				data = []byte(strings.Repeat(" ", maxJournalRecordBytes+1) + "\n")
			}
			if err := os.WriteFile(journal.path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if mode == "oversized-file" {
				if err := os.Truncate(journal.path, maxJournalBytes+1); err != nil {
					t.Fatal(err)
				}
			}
			lock, err = store.Acquire(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			if _, err := store.OpenJournal(lock); err == nil {
				t.Fatal("invalid journal accepted")
			}
		})
	}
}

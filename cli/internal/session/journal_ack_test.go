package session

import (
	"context"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func TestExplicitUnknownAcknowledgementSurvivesRestartWithoutInventingOutcome(t *testing.T) {
	root := t.TempDir()
	_, lock, journal := journalForTest(t, root, "agent")
	intent := ActionIntent{ActionID: "a_unknown_fixture", Kind: driver.Click, StartedAt: time.Now().UnixMilli(), Scope: ActionScope{BrowserID: "browser", TargetID: "target"}}
	if _, err := journal.Begin(context.Background(), intent); err != nil {
		t.Fatal(err)
	}
	if err := journal.pending(); err == nil {
		t.Fatal("pending intent was not gated")
	}
	if err := journal.AcknowledgeUnknown(context.Background(), "a_other_fixture"); err == nil {
		t.Fatal("unknown ID was accepted")
	}
	if err := journal.AcknowledgeUnknown(context.Background(), intent.ActionID); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, reopened := journalForTest(t, root, "agent")
	if pending, err := reopened.Uncertain(); err != nil || len(pending) != 0 {
		t.Fatalf("ack lost: %v %v", pending, err)
	}
	records, err := reopened.Records()
	if err != nil || len(records) != 1 || records[0].Outcome != nil || !records[0].AcknowledgedUnknown {
		t.Fatalf("ack invented an outcome: %+v %v", records, err)
	}
}

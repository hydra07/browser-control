package devtools

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func TestSequenceCorpusHasActionAndResumeGroundTruth(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "fixtures", "synthetic", "sequences", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	actions, resumes := 0, 0
	seen := map[string]bool{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		sequence, err := ReadSequence(bytes.NewReader(data))
		if err != nil {
			t.Fatalf("%s: %v", filepath.Base(path), err)
		}
		if seen[sequence.ID] {
			t.Fatal("duplicate sequence identity")
		}
		seen[sequence.ID] = true
		if sequence.Kind == ActionSequence {
			actions++
		} else {
			resumes++
		}
	}
	if actions < 5 || resumes < 6 {
		t.Fatalf("sequence corpus incomplete: actions=%d resume=%d", actions, resumes)
	}
	for _, id := range []string{"resume-warm", "resume-gap", "resume-reload", "resume-navigate", "resume-browser-restart", "resume-table-gap", "resume-missing-scope"} {
		if !seen[id] {
			t.Errorf("missing required boundary scenario %s", id)
		}
	}
}

func sequenceSample() Sequence {
	value := "Draft"
	capture := driver.Capture{Epoch: "fixture_test", URL: "http://fixture.test/sequence.html", Browser: "Chrome/test", Frames: []driver.Frame{{ID: "frame", URL: "http://fixture.test/sequence.html"}}, Documents: []driver.Document{{FrameID: "frame", URL: "http://fixture.test/sequence.html", Nodes: []driver.DOMNode{
		{Index: 0, Parent: -1, Handle: 1, Type: 9, Name: "#document"},
		{Index: 1, Parent: 0, Handle: 2, Type: 1, Name: "BUTTON", Attributes: map[string]string{"data-testid": "save", "data-test": "customer"}},
		{Index: 2, Parent: 0, Handle: 3, Type: 1, Name: "SPAN", Attributes: map[string]string{"data-testid": "status"}},
		{Index: 3, Parent: 2, Handle: 4, Type: 3, Name: "#text", Text: value},
	}}}, Accessibility: []driver.AccessTree{{FrameID: "frame", Nodes: []driver.AccessNode{{ID: "button", Handle: 2, Role: "button", Name: "Save"}}}}}
	before := SequenceState{ID: "before", Observation: SnapshotAt, Document: "doc-1", Browser: "browser-1", Snapshot: capture, Nodes: []SequenceNode{{Key: "save", Ref: "e1", Physical: "node-1", Handle: 2, Anchor: "customer"}}, Facts: []SequenceFact{{Key: "status", NodeKey: "status", Property: "text", Captured: true, Value: &value}}, Coverage: SequenceCoverage{Complete: true, ObserverActive: true, Scopes: []string{"fixture-root"}}}
	data, _ := json.Marshal(before)
	var after SequenceState
	_ = json.Unmarshal(data, &after)
	after.ID = "after"
	return Sequence{SchemaVersion: 1, Classification: Synthetic, ID: "sample", Kind: ResumeSequence, States: []SequenceState{before, after}, Transitions: []SequenceTransition{{From: "before", To: "after", Trigger: "reconnect", Expected: SequenceExpectation{DocumentState: "same_document", Provenance: Continuous, Mappings: []RefExpectation{{Key: "save", FromRef: "e1", ToRef: "e1", Decision: Retained, AnchorGuard: GuardMatch}}, Content: []ContentExpectation{{Key: "status", Status: "unchanged", Before: &value, After: &value}}}}}}
}

func TestSequenceReaderRejectsUnprovenIdentityAndContent(t *testing.T) {
	sequence := sequenceSample()
	if err := ValidateSequence(sequence); err != nil {
		t.Fatal(err)
	}
	sequence.States[1].Nodes[0].Physical = "replacement"
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("retained ref accepted for a replaced node")
	}
	sequence.Transitions[0].Expected.Mappings[0].Decision = Stale
	sequence.Transitions[0].Expected.Mappings[0].ToRef = ""
	sequence.Transitions[0].Expected.Mappings[0].AnchorGuard = StaleFingerprint
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("stale mapping concealed a ref rebound in the same epoch")
	}
	sequence = sequenceSample()
	sequence.States[1].Document = "doc-2"
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("retained ref crossed a document epoch")
	}
	sequence = sequenceSample()
	sequence.States[0].Facts[0].Captured = false
	sequence.States[0].Facts[0].Value = nil
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("invented content diff without both captured sides")
	}
	sequence = sequenceSample()
	sequence.States[1].Coverage.Gap = true
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("continuous provenance accepted after observation gap")
	}
	sequence = sequenceSample()
	data, _ := json.Marshal(sequence)
	if _, err := ReadSequence(bytes.NewReader(append(data, []byte(` {"extra":true}`)...))); err == nil {
		t.Fatal("accepted trailing sequence JSON")
	}
}

func TestSequencePublicationUsesPrivacyGateAndCannotOverwrite(t *testing.T) {
	root := fixtureWorktree(t)
	plan, err := PrepareOutput(context.Background(), root, "fixtures/synthetic/sequences/sample.json", Synthetic)
	if err != nil {
		t.Fatal(err)
	}
	sequence := sequenceSample()
	sequence.States[0].Snapshot.URL = "https://example.test/?token=synthetic-private-value"
	if err := plan.WriteSequence(sequence); err == nil {
		t.Fatal("unsafe sequence published")
	}
	if _, err := os.Stat(plan.Path); !os.IsNotExist(err) {
		t.Fatal("privacy failure left a file")
	}
	sequence = sequenceSample()
	if err := plan.WriteSequence(sequence); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(plan.Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadSequence(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if err := plan.WriteSequence(sequence); err == nil {
		t.Fatal("sequence overwritten")
	}
	private, err := PrepareOutput(context.Background(), root, "", Private)
	if err != nil {
		t.Fatal(err)
	}
	if err := private.WriteSequence(sequence); err == nil {
		t.Fatal("sequence writer bypassed classification")
	}
}

func TestSequenceWitnessCannotInventAnchorsOrAttributeCoverage(t *testing.T) {
	sequence := sequenceSample()
	sequence.States[0].Nodes[0].Anchor = "other-customer"
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("fabricated business anchor accepted")
	}
	sequence = sequenceSample()
	if _, err := CaptureFact(sequence.States[0].Snapshot, "save", "attr:data-omitted"); err == nil {
		t.Fatal("omitted attribute was treated as observed")
	}
	sequence.States[1].Snapshot.Documents[0].Nodes[3].Text = "Changed outside the contract"
	if err := ValidateSequence(sequence); err == nil {
		t.Fatal("declared content accepted without matching capture")
	}
}

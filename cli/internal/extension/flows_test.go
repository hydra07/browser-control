package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func BenchmarkListFlows(b *testing.B) {
	b.Setenv("BROWSERCONTROL_HOME", b.TempDir())
	steps := make([]json.RawMessage, 200)
	for i := range steps {
		steps[i] = json.RawMessage(fmt.Sprintf(`{"action":"type","text":%q}`, strings.Repeat("x", 512)))
	}
	for i := range 100 {
		if _, err := SaveFlow(Flow{Name: fmt.Sprintf("Flow %03d", i), Steps: steps}); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := ListFlows(); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		flows, err := ListFlows()
		if err != nil || len(flows) != 100 {
			b.Fatalf("list: %d flows, %v", len(flows), err)
		}
	}
}

func TestListFlowsConcurrentChanges(t *testing.T) {
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	var workers sync.WaitGroup
	for i := range 8 {
		workers.Go(func() {
			id := fmt.Sprintf("flow-%d", i)
			for revision := range 5 {
				_, err := SaveFlow(Flow{ID: id, Name: fmt.Sprintf("Revision %d", revision), Steps: []json.RawMessage{json.RawMessage(`{"action":"click"}`)}})
				if err != nil {
					t.Error(err)
					return
				}
				flows, err := ListFlows()
				if err != nil {
					t.Error(err)
					return
				}
				for _, flow := range flows {
					if flow.Steps != nil {
						t.Error("metadata must not retain steps")
					}
				}
			}
		})
	}
	workers.Wait()
	flows, err := ListFlows()
	if err != nil || len(flows) != 8 {
		t.Fatalf("final list: %d flows, %v", len(flows), err)
	}
	for _, flow := range flows {
		if flow.Name != "Revision 4" {
			t.Fatalf("stale metadata: %+v", flow)
		}
	}
}

func TestListFlowsTracksChanges(t *testing.T) {
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	steps := []json.RawMessage{json.RawMessage(`{"action":"click","name":"Login"}`)}
	if _, err := SaveFlow(Flow{Name: "Login", Steps: steps}); err != nil {
		t.Fatal(err)
	}
	first, err := ListFlows()
	if err != nil || len(first) != 1 || first[0].Steps != nil {
		t.Fatalf("metadata: %+v, %v", first, err)
	}
	first[0].Name = "caller changed its copy"
	second, _ := ListFlows()
	if second[0].Name != "Login" {
		t.Fatal("list must own its result")
	}
	if _, err := SaveFlow(Flow{ID: "login", Name: "Updated", Steps: append(steps, steps...)}); err != nil {
		t.Fatal(err)
	}
	updated, _ := ListFlows()
	if len(updated) != 1 || updated[0].Name != "Updated" || updated[0].StepCount != 2 {
		t.Fatalf("save not reflected: %+v", updated)
	}
	if err := os.WriteFile(filepath.Join(FlowDir(), "external.json"), []byte(`[{"action":"scroll","deltaY":100}]`), 0600); err != nil {
		t.Fatal(err)
	}
	external, _ := ListFlows()
	if len(external) != 2 {
		t.Fatalf("external creation not reflected: %+v", external)
	}
	if err := os.WriteFile(filepath.Join(FlowDir(), "external.json"), []byte(`{"name":"External update","steps":[{"action":"scroll"},{"action":"click"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	changed, _ := ListFlows()
	var found bool
	for _, flow := range changed {
		if flow.ID == "external" {
			found = flow.Name == "External update" && flow.StepCount == 2 && flow.Steps == nil
		}
	}
	if !found {
		t.Fatalf("external update not reflected: %+v", changed)
	}
	if err := DeleteFlow("login"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(FlowDir(), "external.json")); err != nil {
		t.Fatal(err)
	}
	empty, _ := ListFlows()
	if len(empty) != 0 || empty == nil {
		t.Fatalf("deleted files retained: %+v", empty)
	}
}

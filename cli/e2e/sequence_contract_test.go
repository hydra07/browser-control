package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
)

func TestSequenceDefinitionsMatchVersionedContract(t *testing.T) {
	for _, spec := range sequenceCases() {
		t.Run(spec.id, func(t *testing.T) {
			file, err := os.Open(filepath.Join("..", "..", "fixtures", "synthetic", "sequences", spec.id+".json"))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			sequence, err := devtools.ReadSequence(file)
			if err != nil {
				t.Fatal(err)
			}
			if sequence.ID != spec.id || sequence.Kind != spec.kind || len(sequence.States) != len(spec.states) || len(sequence.Transitions) != len(spec.steps) {
				t.Fatal("versioned scenario identity/length drifted from the declared case")
			}
			for i, state := range sequence.States {
				refs := map[string]string{}
				for _, node := range state.Nodes {
					refs[node.Key] = node.Ref
				}
				if state.ID != fmt.Sprintf("s%d", i) || !reflect.DeepEqual(refs, spec.states[i].refs) || !reflect.DeepEqual(state.Facts, spec.states[i].facts) {
					t.Fatal("versioned refs/content drifted from independently declared ground truth")
				}
				complete, scope := true, "fixture-root"
				if spec.mode == "header" {
					complete, scope = false, "header"
				}
				active, gap := true, false
				if i > 0 && spec.steps[i-1].op == sequenceIdle && spec.steps[i-1].value != "warm" && spec.steps[i-1].value != "header" {
					active, gap = false, true
				}
				if state.Coverage.Complete != complete || state.Coverage.ObserverActive != active || state.Coverage.Gap != gap || !reflect.DeepEqual(state.Coverage.Scopes, []string{scope}) {
					t.Fatal("versioned observation coverage drifted from the case")
				}
			}
			for i, step := range spec.steps {
				expected := devtools.SequenceTransition{From: fmt.Sprintf("s%d", i), To: fmt.Sprintf("s%d", i+1), Trigger: string(step.op), Offline: step.op == sequenceIdle || step.op == sequenceRestart, Reopen: step.op == sequenceRestart, Expected: sequenceExpected(spec.states[i], spec.states[i+1], step)}
				if !reflect.DeepEqual(sequence.Transitions[i], expected) {
					t.Fatal("versioned transition contract drifted from its scenario definition")
				}
			}
		})
	}
}

func TestActionSequenceGroundTruthCoversEveryInputTarget(t *testing.T) {
	for _, spec := range sequenceCases() {
		if spec.kind != devtools.ActionSequence {
			continue
		}
		for i, step := range spec.steps {
			if step.op != sequenceClick && step.op != sequenceFill {
				continue
			}
			if spec.states[i].refs[step.target] == "" {
				t.Errorf("%s step %d has no ground truth ref for its input target", spec.id, i+1)
			}
		}
	}
}

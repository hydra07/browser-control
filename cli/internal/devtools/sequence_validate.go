package devtools

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

func ValidateSequence(sequence Sequence) error {
	if sequence.SchemaVersion != 1 || sequence.Classification != Synthetic || sequence.ID == "" || sequence.Kind != ActionSequence && sequence.Kind != ResumeSequence {
		return errors.New("invalid sequence identity/classification")
	}
	if len(sequence.States) < 2 || len(sequence.States) > 16 || len(sequence.Transitions) != len(sequence.States)-1 {
		return errors.New("invalid sequence state/transition budget")
	}
	if sequence.Kind == ActionSequence && len(sequence.States) < 3 {
		return errors.New("action sequence requires at least two actions")
	}
	states := map[string]SequenceState{}
	refWitnesses := map[string]SequenceNode{}
	for _, state := range sequence.States {
		if _, duplicate := states[state.ID]; duplicate || state.ID == "" || state.Document == "" || state.Browser == "" || state.Observation != SnapshotAt {
			return errors.New("invalid sequence state identity")
		}
		if state.Snapshot.Truncated || len(state.Snapshot.Frames) == 0 || len(state.Snapshot.Documents) == 0 || len(state.Snapshot.Accessibility) == 0 {
			return errors.New("sequence requires complete DOM/AX/frame evidence")
		}
		if len(state.Nodes) > 512 || len(state.Facts) > 512 || len(state.Coverage.History) > 32 || len(state.Coverage.Scopes) == 0 || state.Coverage.Revision < state.Coverage.OldestRevision || state.Coverage.OldestRevision < 0 {
			return errors.New("invalid sequence evidence budget/coverage")
		}
		refs, keys := map[string]bool{}, map[string]bool{}
		for _, node := range state.Nodes {
			if node.Key == "" || node.Ref == "" || node.Physical == "" || keys[node.Key] || refs[node.Ref] {
				return errors.New("invalid or duplicate fixture reference")
			}
			keys[node.Key], refs[node.Ref] = true, true
			identity := state.Document + "/" + node.Ref
			if previous, exists := refWitnesses[identity]; exists && (previous.Physical != node.Physical || previous.Handle != node.Handle || previous.Key != node.Key) {
				return errors.New("a document ref was rebound to another physical node")
			}
			refWitnesses[identity] = node
			witness, err := WitnessNode(state.Snapshot, node.Key)
			if err != nil || witness.Handle != node.Handle {
				return errors.New("ref ground truth does not match captured DOM witness")
			}
			anchor, err := CaptureFact(state.Snapshot, node.Key, "anchor")
			if err != nil || anchor == nil || *anchor != node.Anchor {
				return errors.New("business anchor does not match captured DOM ancestry")
			}
		}
		keys = map[string]bool{}
		for _, fact := range state.Facts {
			if fact.Key == "" || fact.NodeKey == "" || keys[fact.Key] {
				return errors.New("invalid or duplicate content witness")
			}
			keys[fact.Key] = true
			if !fact.Captured {
				if fact.Value != nil {
					return errors.New("unobserved field cannot carry a checkpoint value")
				}
				continue
			}
			value, err := CaptureFact(state.Snapshot, fact.NodeKey, fact.Property)
			if err != nil || !sameText(value, fact.Value) {
				return errors.New("content ground truth does not match captured DOM")
			}
		}
		states[state.ID] = state
	}
	for i, transition := range sequence.Transitions {
		before, from := states[transition.From]
		after, to := states[transition.To]
		if !from || !to || transition.From != sequence.States[i].ID || transition.To != sequence.States[i+1].ID || transition.Trigger == "" {
			return errors.New("sequence transitions must connect consecutive states")
		}
		if err := validateTransition(before, after, transition); err != nil {
			return fmt.Errorf("transition %d: %w", i+1, err)
		}
	}
	return nil
}

func validateTransition(before, after SequenceState, transition SequenceTransition) error {
	sameDocument, sameBrowser := before.Document == after.Document, before.Browser == after.Browser
	switch transition.Expected.DocumentState {
	case SameDocument:
		if !sameDocument || !sameBrowser {
			return errors.New("same-document expectation crossed an epoch/browser")
		}
	case Reloaded:
		if sameDocument || !sameBrowser || before.Snapshot.URL != after.Snapshot.URL {
			return errors.New("reload witness mismatch")
		}
	case Navigated:
		if sameDocument || !sameBrowser || before.Snapshot.URL == after.Snapshot.URL {
			return errors.New("navigation witness mismatch")
		}
	case BrowserRestarted:
		if sameBrowser || sameDocument || !transition.Reopen {
			return errors.New("browser restart requires a new browser/document and explicit reopen")
		}
	default:
		return errors.New("unsupported document transition")
	}
	provenance := Reconstructed
	if !before.Coverage.Complete || !after.Coverage.Complete {
		provenance = Incomplete
	} else if sameDocument && sameBrowser && !after.Coverage.Gap && before.Coverage.ObserverActive && after.Coverage.ObserverActive && after.Coverage.OldestRevision <= before.Coverage.Revision {
		provenance = Continuous
	}
	if transition.Expected.Provenance != provenance {
		return errors.New("provenance contradicts observation coverage")
	}
	if sameDocument && after.Coverage.Revision < before.Coverage.Revision {
		return errors.New("observation revision moved backwards")
	}
	seen := map[string]bool{}
	for _, mapping := range transition.Expected.Mappings {
		old, oldFound := sequenceNode(before, mapping.Key)
		current, found := sequenceNode(after, mapping.Key)
		if !oldFound || seen[mapping.Key] || mapping.FromRef != old.Ref {
			return errors.New("invalid source ref mapping")
		}
		seen[mapping.Key] = true
		switch mapping.Decision {
		case Retained:
			if !sameDocument || !sameBrowser || !found || old.Physical != current.Physical || old.Handle != current.Handle || old.Ref != current.Ref || mapping.ToRef != current.Ref {
				return errors.New("retained ref has no physical continuity")
			}
		case Remapped:
			if sameDocument || !found || mapping.ToRef != current.Ref || old.Anchor != current.Anchor || axIdentity(before, old.Handle) == "" || axIdentity(before, old.Handle) != axIdentity(after, current.Handle) {
				return errors.New("remap lacks a unique matching fingerprint in a new epoch")
			}
		case Stale:
			if mapping.ToRef != "" || sameDocument && sameBrowser && found && old.Physical == current.Physical {
				return errors.New("stale ref was silently rebound or still names the same live node")
			}
		default:
			return errors.New("unsupported ref mapping decision")
		}
		guard := GuardMatch
		if mapping.Decision == Stale || found && old.Anchor != current.Anchor {
			guard = StaleFingerprint
		}
		if mapping.AnchorGuard != guard {
			return errors.New("fingerprint guard contradicts the business anchor")
		}
	}
	if len(seen) != len(before.Nodes) {
		return errors.New("source refs are missing explicit mappings")
	}
	keys := map[string]bool{}
	for _, fact := range before.Facts {
		keys[fact.Key] = true
	}
	for _, fact := range after.Facts {
		keys[fact.Key] = true
	}
	seen = map[string]bool{}
	for _, content := range transition.Expected.Content {
		if !keys[content.Key] || seen[content.Key] {
			return errors.New("unknown or duplicate expected content field")
		}
		seen[content.Key] = true
		old, oldFound := sequenceFact(before, content.Key)
		current, found := sequenceFact(after, content.Key)
		status := "not_observed"
		var from, to *string
		if oldFound && found && old.Captured && current.Captured {
			from, to = old.Value, current.Value
			switch {
			case sameText(from, to):
				status = "unchanged"
			case from == nil:
				status = "added"
			case to == nil:
				status = "removed"
			default:
				status = "changed"
			}
		}
		if content.Status != status || !sameText(content.Before, from) || !sameText(content.After, to) {
			return errors.New("content diff contradicts captured values/coverage")
		}
	}
	if len(keys) != len(seen) {
		return errors.New("missing expected content coverage")
	}
	if provenance == Continuous && !slices.Equal(before.Coverage.Scopes, after.Coverage.Scopes) {
		return errors.New("continuous scope changed without a gap")
	}
	return nil
}

func sequenceNode(state SequenceState, key string) (SequenceNode, bool) {
	for _, node := range state.Nodes {
		if node.Key == key {
			return node, true
		}
	}
	return SequenceNode{}, false
}

func sequenceFact(state SequenceState, key string) (SequenceFact, bool) {
	for _, fact := range state.Facts {
		if fact.Key == key {
			return fact, true
		}
	}
	return SequenceFact{}, false
}

func sameText(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

func axIdentity(state SequenceState, handle int) string {
	for _, tree := range state.Snapshot.Accessibility {
		for _, node := range tree.Nodes {
			if node.Handle == handle && !node.Ignored {
				return strings.Join([]string{node.Role, node.Name}, "\x00")
			}
		}
	}
	return ""
}

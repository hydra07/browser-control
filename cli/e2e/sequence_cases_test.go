package e2e

import (
	"sort"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
)

type sequenceOperation string

const (
	sequenceClick    sequenceOperation = "click"
	sequenceFill     sequenceOperation = "fill"
	sequenceIdle     sequenceOperation = "idle"
	sequenceReload   sequenceOperation = "reload"
	sequenceNavigate sequenceOperation = "navigate"
	sequenceRestart  sequenceOperation = "restart"
)

type sequenceStateSpec struct {
	refs  map[string]string
	facts []devtools.SequenceFact
}

type sequenceStepSpec struct {
	op                                  sequenceOperation
	target, value, document, provenance string
	decisions, guards                   map[string]string
}

type sequenceCase struct {
	id     string
	kind   devtools.SequenceKind
	mode   string
	states []sequenceStateSpec
	steps  []sequenceStepSpec
}

func sequenceCases() []sequenceCase {
	save := map[string]string{"save": "e1"}
	formRefs := map[string]string{"save": "e1", "customer-name": "e2"}
	modalBefore := map[string]string{"save": "e1", "open-editor": "e2"}
	modalAfter := map[string]string{"save": "e1", "open-editor": "e2", "save-order": "e3"}
	status := func(value string) []devtools.SequenceFact {
		return []devtools.SequenceFact{sequenceFact("status", "status", "text", value)}
	}
	state := func(refs map[string]string, facts []devtools.SequenceFact) sequenceStateSpec {
		return sequenceStateSpec{refs: refs, facts: facts}
	}
	step := func(op sequenceOperation, target, value, document, provenance string) sequenceStepSpec {
		return sequenceStepSpec{op: op, target: target, value: value, document: document, provenance: provenance}
	}
	form := func(name, message string) []devtools.SequenceFact {
		return []devtools.SequenceFact{sequenceFact("customer-name", "customer-name", "value", name), sequenceFact("status", "status", "text", message)}
	}
	rows := map[string]string{"save": "e1", "row-slot-0-action": "e2", "row-slot-1-action": "e3"}
	orderingRefs := map[string]string{"save": "e1", "row-slot-0-action": "e2", "row-slot-1-action": "e3", "insert": "e4", "reorder": "e5"}
	rowOrder := "ORD-42 Mai Nguyen Pending Open ORD-43 Ada Lovelace Pending Open"
	reordered := "ORD-43 Ada Lovelace Pending Open ORD-42 Mai Nguyen Pending Open"
	ordering := func(extra *string, order string) []devtools.SequenceFact {
		return []devtools.SequenceFact{{Key: "extra", NodeKey: "extra", Property: "text", Captured: true, Value: extra}, sequenceFact("row-order", "rows", "text", order)}
	}
	extra := "Extra action"
	virtual := func(next bool) []devtools.SequenceFact {
		old := sequenceFact("order:ORD-42.status", "row-slot-0-status", "text", "Pending")
		new := devtools.SequenceFact{Key: "order:ORD-44.status", NodeKey: "row-slot-0-status", Property: "text"}
		if next {
			old.Captured, old.Value = false, nil
			new = sequenceFact("order:ORD-44.status", "row-slot-0-status", "text", "Queued")
		}
		return []devtools.SequenceFact{old, new, sequenceFact("row-total-hint", "orders-table", "attr:aria-rowcount", "1000")}
	}
	retained := map[string]string{"row-slot-0-action": "e1", "next-window": "e2", "previous-window": "e3"}
	replacementBefore := map[string]string{"replace-target": "e1", "replace": "e3"}
	replacementAfter := map[string]string{"replace-target": "e2", "replace": "e3"}
	replace := step(sequenceClick, "replace", "", "same_document", devtools.Continuous)
	replace.decisions = map[string]string{"replace-target": devtools.Stale}
	virtualNext := step(sequenceClick, "next-window", "", "same_document", devtools.Continuous)
	virtualNext.guards = map[string]string{"row-slot-0-action": devtools.StaleFingerprint}
	virtualPrevious := step(sequenceClick, "previous-window", "", "same_document", devtools.Continuous)
	virtualPrevious.guards = map[string]string{"row-slot-0-action": devtools.StaleFingerprint}
	reload := step(sequenceReload, "", "", "reloaded", devtools.Reconstructed)
	reload.decisions = map[string]string{"save": devtools.Remapped}
	restart := step(sequenceRestart, "", "", "browser_restarted", devtools.Reconstructed)
	restart.decisions = map[string]string{"save": devtools.Remapped}
	navigate := step(sequenceNavigate, "navigate", "", "navigated", devtools.Reconstructed)
	navigate.decisions = map[string]string{"save": devtools.Stale}
	tableBefore := []devtools.SequenceFact{sequenceFact("order:ORD-42.status", "row-slot-0-status", "text", "Pending"), sequenceFact("order:ORD-43.status", "row-slot-1-status", "text", "Pending"), {Key: "order:ORD-44.status", NodeKey: "row-slot-2-status", Property: "text", Captured: true}}
	tableAfter := []devtools.SequenceFact{sequenceFact("order:ORD-42.status", "row-slot-0-status", "text", "Paid"), {Key: "order:ORD-43.status", NodeKey: "row-slot-1-status", Property: "text", Captured: true}, sequenceFact("order:ORD-44.status", "row-slot-2-status", "text", "Queued")}
	tableGap := step(sequenceIdle, "", "table", "same_document", devtools.Reconstructed)
	tableGap.decisions = map[string]string{"row-slot-1-action": devtools.Stale}
	missingBefore := []devtools.SequenceFact{{Key: "status", NodeKey: "status", Property: "text"}}
	return []sequenceCase{
		{id: "action-form-save", kind: devtools.ActionSequence, states: []sequenceStateSpec{state(formRefs, form("Mai Nguyen", "Draft")), state(formRefs, form("Linh Tran", "Editing Linh Tran")), state(formRefs, form("Linh Tran", "Saved Linh Tran"))}, steps: []sequenceStepSpec{step(sequenceFill, "customer-name", "Linh Tran", "same_document", devtools.Continuous), step(sequenceClick, "save", "", "same_document", devtools.Continuous)}},
		{id: "action-modal", kind: devtools.ActionSequence, states: []sequenceStateSpec{state(modalBefore, status("Draft")), state(modalAfter, status("Editing order")), state(modalAfter, status("Order saved"))}, steps: []sequenceStepSpec{step(sequenceClick, "open-editor", "", "same_document", devtools.Continuous), step(sequenceClick, "save-order", "", "same_document", devtools.Continuous)}},
		{id: "action-insert-reorder", kind: devtools.ActionSequence, states: []sequenceStateSpec{state(orderingRefs, ordering(nil, rowOrder)), state(orderingRefs, ordering(&extra, rowOrder)), state(orderingRefs, ordering(&extra, reordered))}, steps: []sequenceStepSpec{step(sequenceClick, "insert", "", "same_document", devtools.Continuous), step(sequenceClick, "reorder", "", "same_document", devtools.Continuous)}},
		{id: "action-replacement", kind: devtools.ActionSequence, states: []sequenceStateSpec{state(replacementBefore, status("Draft")), state(replacementAfter, status("Draft")), state(replacementAfter, status("Replacement clicked"))}, steps: []sequenceStepSpec{replace, step(sequenceClick, "replace-target", "", "same_document", devtools.Continuous)}},
		{id: "action-virtualized", kind: devtools.ActionSequence, mode: "virtual", states: []sequenceStateSpec{state(retained, virtual(false)), state(retained, virtual(true)), state(retained, virtual(false))}, steps: []sequenceStepSpec{virtualNext, virtualPrevious}},
		{id: "resume-warm", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(save, status("Draft")), state(save, status("Updated while idle"))}, steps: []sequenceStepSpec{step(sequenceIdle, "", "warm", "same_document", devtools.Continuous)}},
		{id: "resume-gap", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(save, status("Draft")), state(save, status("Updated while idle"))}, steps: []sequenceStepSpec{step(sequenceIdle, "", "cold", "same_document", devtools.Reconstructed)}},
		{id: "resume-reload", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(save, status("Draft")), state(save, status("Draft"))}, steps: []sequenceStepSpec{reload}},
		{id: "resume-navigate", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(save, []devtools.SequenceFact{sequenceFact("screen-title", "screen-title", "text", "Customer orders")}), state(map[string]string{}, []devtools.SequenceFact{sequenceFact("screen-title", "screen-title", "text", "Monthly report")})}, steps: []sequenceStepSpec{navigate}},
		{id: "resume-browser-restart", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(save, status("Draft")), state(save, status("Draft"))}, steps: []sequenceStepSpec{restart}},
		{id: "resume-table-gap", kind: devtools.ResumeSequence, states: []sequenceStateSpec{state(rows, tableBefore), state(map[string]string{"save": "e1", "row-slot-0-action": "e2", "row-slot-2-action": "e4"}, tableAfter)}, steps: []sequenceStepSpec{tableGap}},
		{id: "resume-missing-scope", kind: devtools.ResumeSequence, mode: "header", states: []sequenceStateSpec{state(save, missingBefore), state(save, status("Updated while idle"))}, steps: []sequenceStepSpec{step(sequenceIdle, "", "header", "same_document", devtools.Incomplete)}},
	}
}

func sequenceFact(key, node, property, value string) devtools.SequenceFact {
	return devtools.SequenceFact{Key: key, NodeKey: node, Property: property, Captured: true, Value: &value}
}

func sequenceExpected(before, after sequenceStateSpec, step sequenceStepSpec) devtools.SequenceExpectation {
	expected := devtools.SequenceExpectation{DocumentState: step.document, Provenance: step.provenance, Mappings: []devtools.RefExpectation{}, Content: []devtools.ContentExpectation{}}
	for _, key := range sequenceSortedKeys(before.refs) {
		decision, guard := devtools.Retained, devtools.GuardMatch
		if override := step.decisions[key]; override != "" {
			decision = override
		}
		if override := step.guards[key]; override != "" {
			guard = override
		}
		to := after.refs[key]
		if decision == devtools.Stale {
			to, guard = "", devtools.StaleFingerprint
		}
		expected.Mappings = append(expected.Mappings, devtools.RefExpectation{Key: key, FromRef: before.refs[key], ToRef: to, Decision: decision, AnchorGuard: guard})
	}
	for _, old := range before.facts {
		var current devtools.SequenceFact
		for _, fact := range after.facts {
			if fact.Key == old.Key {
				current = fact
			}
		}
		content := devtools.ContentExpectation{Key: old.Key, Status: "not_observed"}
		if old.Captured && current.Captured {
			content.Before, content.After = old.Value, current.Value
			switch {
			case old.Value == nil && current.Value == nil || old.Value != nil && current.Value != nil && *old.Value == *current.Value:
				content.Status = "unchanged"
			case old.Value == nil:
				content.Status = "added"
			case current.Value == nil:
				content.Status = "removed"
			default:
				content.Status = "changed"
			}
		}
		expected.Content = append(expected.Content, content)
	}
	return expected
}

func sequenceSortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

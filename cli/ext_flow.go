package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Environment bindings resolve only at execution, never in saved flow files.
func bindFlowEnvironment(steps []json.RawMessage) ([]json.RawMessage, error) {
	bound := make([]json.RawMessage, len(steps))
	for i, raw := range steps {
		var step map[string]any
		if err := json.Unmarshal(raw, &step); err != nil || step == nil {
			return nil, usagef("step %d: expected an object", i)
		}
		if value, ok := step["textFromEnv"]; ok {
			name, ok := value.(string)
			if !ok || name == "" {
				return nil, usagef("step %d: textFromEnv must name an environment variable", i)
			}
			if step["action"] != "type" && step["action"] != "fill" {
				return nil, usagef("step %d: textFromEnv is only supported by type/fill", i)
			}
			if _, exists := step["text"]; exists {
				return nil, usagef("step %d: use text or textFromEnv, not both", i)
			}
			text, exists := os.LookupEnv(name)
			if !exists {
				return nil, fmt.Errorf("step %d: required environment variable %s is not set", i, name)
			}
			step["text"] = text
			delete(step, "textFromEnv")
		}
		var err error
		bound[i], err = json.Marshal(step)
		if err != nil {
			return nil, err
		}
	}
	return bound, nil
}

func renderFlowReport(res map[string]any, a cmdArgs) string {
	steps := asSlice(res["steps"])
	state := "dispatched; outcome unverified"
	if res["verified"] == true {
		state = "verified"
	}
	header := fmt.Sprintf("ok: flow %s (%d steps; %s)", str(res["runId"]), len(steps), state)
	if res["success"] != true {
		header = "flow failed: " + truncate(firstNonEmptyString(str(res["message"]), str(res["error"]), str(res["reason"]), "command failed"), 300)
		if index, ok := res["stoppedAtStep"].(float64); ok {
			header += fmt.Sprintf(" (stopped at step %d)", int(index)+1)
		}
	}
	lines := []string{header}
	for i, value := range steps {
		step := asMap(value)
		state := "failed"
		if step["success"] == true {
			state = "dispatched; outcome unverified"
			if step["verified"] == true {
				state = "verified"
			}
		}
		index := i + 1
		if value, ok := step["index"].(float64); ok {
			index = int(value) + 1
		}
		line := fmt.Sprintf("%d. %s: %s", index, str(step["action"]), state)
		if err := str(step["error"]); err != "" {
			line += " (" + truncate(err, 120) + ")"
		}
		if drift := str(step["drift"]); drift != "" && drift != "EXACT" {
			line += " [" + drift + "]"
		}
		lines = append(lines, line)
		if hint := str(step["recoveryHint"]); hint != "" {
			lines = append(lines, "hint: "+truncate(cliHint(hint), 200))
		}
	}
	if nodes, ok := res["finalSnapshot"].([]any); ok {
		entries := formatEntries(nodes)
		view := filterLines(entries, flagStr(a, "grep"), flagInt(a, "limit", defaultSnapshotLimit))
		lines = append(lines, "snapshot:", strings.Join(view.kept, "\n"))
		if view.dropped > 0 {
			lines = append(lines, strings.TrimPrefix(snapshotOmitted(len(view.kept), len(entries)), "\n"))
		}
	}
	return strings.Join(lines, "\n")
}

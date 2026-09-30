package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Flow is one saved flow on disk; its JSON shape is what the side panel's FlowMeta/FlowFull expect.
type Flow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Domain      string `json:"domain,omitempty"`
	StepCount   int    `json:"stepCount"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	// Steps stay raw JSON so fields this package doesn't model still reach the extension unchanged.
	Steps []json.RawMessage `json:"steps,omitempty"`
}

var flowIDUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

func FlowDir() string { return filepath.Join(homeDir(), "flows") }

func FlowID(name string) string {
	id := strings.Trim(flowIDUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-"), "-.")
	if id == "" {
		id = fmt.Sprintf("flow-%d", time.Now().UnixMilli())
	}
	return id
}

func flowPath(id string) string { return filepath.Join(FlowDir(), FlowID(id)+".json") }

/** Reads a saved flow; older files that were a bare step array or lacked metadata are normalised on the way in. */
func GetFlow(id string) (*Flow, error) {
	path := flowPath(id)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no saved flow %q", id)
		}
		return nil, err
	}
	return decodeFlow(data, FlowID(id), path)
}

func decodeFlow(data []byte, id, path string) (*Flow, error) {
	var flow Flow
	if err := json.Unmarshal(data, &flow.Steps); err != nil {
		if err := json.Unmarshal(data, &flow); err != nil {
			return nil, fmt.Errorf("%s is not a flow: %w", path, err)
		}
	}
	if flow.ID == "" {
		flow.ID = id
	}
	if flow.Name == "" {
		flow.Name = flow.ID
	}
	flow.StepCount = len(flow.Steps)
	if flow.UpdatedAt == 0 {
		if info, err := os.Stat(path); err == nil {
			flow.UpdatedAt = info.ModTime().UnixMilli()
		}
	}
	if flow.CreatedAt == 0 {
		flow.CreatedAt = flow.UpdatedAt
	}
	return &flow, nil
}

// ListFlows returns metadata only (no steps), newest first.
func ListFlows() ([]Flow, error) {
	entries, err := os.ReadDir(FlowDir())
	if os.IsNotExist(err) {
		return []Flow{}, nil
	}
	if err != nil {
		return nil, err
	}
	flows := []Flow{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || e.IsDir() {
			continue
		}
		flow, err := GetFlow(id)
		if err != nil {
			continue
		}
		flow.Steps = nil
		flows = append(flows, *flow)
	}
	sort.Slice(flows, func(i, j int) bool { return flows[i].UpdatedAt > flows[j].UpdatedAt })
	return flows, nil
}

/** Creates or replaces a flow, keeping the original createdAt when an id is reused. */
func SaveFlow(flow Flow) (*Flow, error) {
	if len(flow.Steps) == 0 {
		return nil, fmt.Errorf("flow has no steps")
	}
	if flow.ID == "" {
		flow.ID = flow.Name
	}
	flow.ID = FlowID(flow.ID)
	if flow.Name == "" {
		flow.Name = flow.ID
	}
	now := time.Now().UnixMilli()
	flow.CreatedAt, flow.UpdatedAt, flow.StepCount = now, now, len(flow.Steps)
	if existing, err := GetFlow(flow.ID); err == nil {
		flow.CreatedAt = existing.CreatedAt
	}
	data, err := json.MarshalIndent(flow, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(FlowDir(), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(flowPath(flow.ID), data, 0o600); err != nil {
		return nil, err
	}
	return &flow, nil
}

func DeleteFlow(id string) error {
	if err := os.Remove(flowPath(id)); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no saved flow %q", id)
		}
		return err
	}
	return nil
}

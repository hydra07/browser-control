package extension

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Flow is one saved flow on disk; its JSON shape is what the side panel's FlowMeta/FlowFull expect.
type Flow struct {
	ID            string `json:"id"`
	SchemaVersion int    `json:"schemaVersion,omitempty"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	Domain        string `json:"domain,omitempty"`
	StepCount     int    `json:"stepCount"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
	// Steps stay raw JSON so fields this package doesn't model still reach the extension unchanged.
	Steps []json.RawMessage `json:"steps,omitempty"`
}

var flowIDUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

type flowMetadataEntry struct {
	info os.FileInfo
	flow Flow
}

var flowMetadata = struct {
	sync.Mutex
	dir     string
	entries map[string]flowMetadataEntry
}{}

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
	flowMetadata.Lock()
	defer flowMetadata.Unlock()
	dir := FlowDir()
	if flowMetadata.dir != dir {
		flowMetadata.dir = dir
		flowMetadata.entries = make(map[string]flowMetadataEntry)
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		clear(flowMetadata.entries)
		return []Flow{}, nil
	}
	if err != nil {
		return nil, err
	}
	flows := make([]Flow, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		cached, exists := flowMetadata.entries[e.Name()]
		/** Cache only metadata; file identity also catches atomic replacements with unchanged timestamps. */
		if !exists || info.Size() != cached.info.Size() || !info.ModTime().Equal(cached.info.ModTime()) || !os.SameFile(info, cached.info) {
			path := filepath.Join(dir, e.Name())
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			flow, err := decodeFlow(data, id, path)
			if err != nil {
				continue
			}
			flow.Steps = nil
			cached = flowMetadataEntry{info: info, flow: *flow}
			flowMetadata.entries[e.Name()] = cached
		}
		seen[e.Name()] = true
		flows = append(flows, cached.flow)
	}
	for name := range flowMetadata.entries {
		if !seen[name] {
			delete(flowMetadata.entries, name)
		}
	}
	sort.Slice(flows, func(i, j int) bool {
		if flows[i].UpdatedAt == flows[j].UpdatedAt {
			return flows[i].ID < flows[j].ID
		}
		return flows[i].UpdatedAt > flows[j].UpdatedAt
	})
	return flows, nil
}

/** Creates or replaces a flow, keeping the original createdAt when an id is reused. */
func SaveFlow(flow Flow) (*Flow, error) {
	if flow.SchemaVersion != 0 && flow.SchemaVersion != 1 && flow.SchemaVersion != 2 {
		return nil, fmt.Errorf("unsupported flow schemaVersion %d", flow.SchemaVersion)
	}
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
	if err := WriteFileAtomic(flowPath(flow.ID), data); err != nil {
		return nil, err
	}
	invalidateFlowMetadata(flow.ID)
	return &flow, nil
}

func DeleteFlow(id string) error {
	if err := os.Remove(flowPath(id)); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no saved flow %q", id)
		}
		return err
	}
	invalidateFlowMetadata(id)
	return nil
}

func invalidateFlowMetadata(id string) {
	flowMetadata.Lock()
	defer flowMetadata.Unlock()
	delete(flowMetadata.entries, FlowID(id)+".json")
}

package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type StoredFlow struct {
	ID          string     `json:"id"`
	Name        string     `json:"name,omitempty"`
	Description string     `json:"description,omitempty"`
	Domain      string     `json:"domain,omitempty"`
	Path        string     `json:"path"`
	Steps       []FlowStep `json:"steps"`
}

func BrowserControlDir() string {
	if override := strings.TrimSpace(os.Getenv("BROWSERCONTROL_HOME")); override != "" {
		return override
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".browsercontrol")
	}
	return filepath.Join(".", ".browsercontrol")
}

func FlowStoreDir() string {
	return filepath.Join(BrowserControlDir(), "flows")
}

func ListSavedFlows() ([]StoredFlow, error) {
	dir := FlowStoreDir()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []StoredFlow{}, nil
	}
	if err != nil {
		return nil, err
	}
	flows := []StoredFlow{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		flow, err := loadStoredFlow(filepath.Join(dir, entry.Name()))
		if err == nil {
			flows = append(flows, *flow)
		}
	}
	sort.Slice(flows, func(i, j int) bool { return flows[i].ID < flows[j].ID })
	return flows, nil
}

func GetSavedFlow(id string) (*StoredFlow, error) {
	path := flowPath(id)
	flow, err := loadStoredFlow(path)
	if err != nil {
		return nil, err
	}
	return flow, nil
}

func SaveFlow(id string, sourcePath string) (*StoredFlow, error) {
	steps, err := LoadFlowFile(sourcePath)
	if err != nil {
		return nil, err
	}
	flow := StoredFlow{ID: sanitizeID(id), Name: id, Path: flowPath(id), Steps: steps}
	if flow.ID == "" {
		return nil, fmt.Errorf("flow id cannot be empty")
	}
	if err := os.MkdirAll(FlowStoreDir(), 0755); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(flow, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(flow.Path, data, 0644); err != nil {
		return nil, err
	}
	return &flow, nil
}

func DeleteSavedFlow(id string) error {
	if err := os.Remove(flowPath(id)); err != nil {
		return err
	}
	return nil
}

func loadStoredFlow(path string) (*StoredFlow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var flow StoredFlow
	if err := json.Unmarshal(data, &flow); err == nil && len(flow.Steps) > 0 {
		if flow.ID == "" {
			flow.ID = strings.TrimSuffix(filepath.Base(path), ".json")
		}
		flow.Path = path
		return &flow, nil
	}
	var doc FlowDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	id := doc.ID
	if id == "" {
		id = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	return &StoredFlow{ID: id, Name: doc.Name, Description: doc.Description, Domain: doc.Domain, Path: path, Steps: doc.Steps}, nil
}

func flowPath(id string) string {
	return filepath.Join(FlowStoreDir(), sanitizeID(id)+".json")
}

var invalidFlowID = regexp.MustCompile(`[^a-zA-Z0-9_.-]+`)

func sanitizeID(id string) string {
	id = strings.TrimSpace(id)
	id = strings.TrimSuffix(filepath.Base(id), ".json")
	id = invalidFlowID.ReplaceAllString(id, "-")
	return strings.Trim(id, "-_.")
}

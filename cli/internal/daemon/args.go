package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

var commandNames = map[string]struct{}{
	"navigate":               {},
	"snapshot":               {},
	"query_region":           {},
	"visual_snapshot":        {},
	"click":                  {},
	"type":                   {},
	"press_key":              {},
	"scroll":                 {},
	"drag":                   {},
	"screenshot":             {},
	"network_requests":       {},
	"network_request_detail": {},
	"network_clear":          {},
	"inspect_element":        {},
	"evaluate":               {},
	"run_flow":               {},
	"explore_flow":           {},
	"list_tabs":              {},
	"switch_tab":             {},
	"peek_screen":            {},
	"start_capture":          {},
	"stop_capture":           {},
	"evidence":               {},
	"reading_mode":           {},
	"find":                   {},
	"select_content":         {},
	"batch_crawl":            {},
	"close_tab":              {},
	"web_search":             {},
	"dev_memory":             {},
	"dev_process":            {},
	"dev_har":                {},
	"dev_layout":             {},
	"dev_emulate":            {},
	"dev_sandbox":            {},
	"start_flow_recording":   {},
	"stop_flow_recording":    {},
	"flow_recording_status":  {},
}

func NormalizeCommandName(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "-", "_")
}

func IsKnownCommand(value string) bool {
	_, ok := commandNames[NormalizeCommandName(value)]
	return ok
}

func ParsePayloadArgs(args []string) (map[string]any, error) {
	payload := map[string]any{}
	for _, arg := range args {
		if strings.TrimSpace(arg) == "" {
			continue
		}
		if strings.HasPrefix(arg, "@") {
			object, err := readJSONObject(strings.TrimPrefix(arg, "@"))
			if err != nil {
				return nil, err
			}
			merge(payload, object)
			continue
		}
		trimmed := strings.TrimSpace(arg)
		if strings.HasPrefix(trimmed, "{") {
			var object map[string]any
			if err := json.Unmarshal([]byte(trimmed), &object); err != nil {
				return nil, fmt.Errorf("parse inline JSON object: %w", err)
			}
			merge(payload, object)
			continue
		}
		key, raw, ok := strings.Cut(arg, "=")
		if !ok {
			return nil, fmt.Errorf("expected payload argument %q to be key=value, @file.json, or inline JSON object", arg)
		}
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("empty key in payload argument %q", arg)
		}
		value, err := parseValue(raw)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		payload[key] = value
	}
	return payload, nil
}

func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read payload file %q: %w", path, err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, fmt.Errorf("payload file %q must contain a JSON object: %w", path, err)
	}
	return object, nil
}

func parseValue(raw string) (any, error) {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(value, "@") {
		data, err := os.ReadFile(strings.TrimPrefix(value, "@"))
		if err != nil {
			return nil, err
		}
		trimmed := strings.TrimSpace(string(data))
		var decoded any
		if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
			return decoded, nil
		}
		return string(data), nil
	}
	if value == "" {
		return "", nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err == nil {
		return decoded, nil
	}
	if i, err := strconv.ParseInt(value, 10, 64); err == nil {
		return i, nil
	}
	if f, err := strconv.ParseFloat(value, 64); err == nil {
		return f, nil
	}
	return raw, nil
}

func merge(dst, src map[string]any) {
	for key, value := range src {
		dst[key] = value
	}
}

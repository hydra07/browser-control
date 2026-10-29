package bench

import (
	"strings"
	"unicode/utf16"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

var legacyInteractiveRoles = map[string]bool{
	"button": true, "link": true, "textbox": true, "searchbox": true, "combobox": true,
	"checkbox": true, "radio": true, "menuitem": true, "treeitem": true, "tab": true, "slider": true,
}

func meaningful(node driver.AccessNode) bool {
	return legacyInteractiveRoles[node.Role] && node.Handle != 0 ||
		(node.Role == "StaticText" || node.Role == "heading" || node.Role == "paragraph") && strings.TrimSpace(node.Name) != ""
}

/** This offline port replays the legacy collector's flat projection; it is not a live Go index. */
func ProjectFlatAX(nodes []driver.AccessNode) []any {
	entries, _ := projectFlatAX(nodes)
	return entries
}

func projectFlatAX(nodes []driver.AccessNode) ([]any, bool) {
	byID := make(map[string]driver.AccessNode, len(nodes))
	for _, node := range nodes {
		byID[node.ID] = node
	}
	redundant := make(map[string]bool)
	for _, node := range nodes {
		if !meaningful(node) || node.Role == "StaticText" {
			continue
		}
		stack := append([]string(nil), node.Children...)
		for len(stack) > 0 {
			id := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if redundant[id] {
				continue
			}
			redundant[id] = true
			stack = append(stack, byID[id].Children...)
		}
	}
	entries := make([]any, 0)
	for _, node := range nodes {
		if !meaningful(node) || node.Role == "StaticText" && redundant[node.ID] {
			continue
		}
		entry := map[string]any{"r": node.Role, "n": node.Name}
		if node.Handle != 0 {
			entry["i"] = float64(node.Handle)
		}
		if node.Value != "" {
			entry["v"] = node.Value
		}
		entries = append(entries, entry)
	}
	return mergeCollectorText(entries)
}

func mergeCollectorText(entries []any) ([]any, bool) {
	result := make([]any, 0, len(entries))
	truncated := false
	for i := 0; i < len(entries); i++ {
		first := entries[i].(map[string]any)
		if first["r"] != "StaticText" {
			result = append(result, first)
			continue
		}
		var text strings.Builder
		text.WriteString(first["n"].(string))
		previousID, previousPresent := first["i"].(float64)
		j := i + 1
		for ; j < len(entries); j++ {
			next := entries[j].(map[string]any)
			if next["r"] != "StaticText" {
				break
			}
			id, present := next["i"].(float64)
			if !present || !previousPresent || id-previousID != 1 {
				text.WriteByte(' ')
			}
			text.WriteString(next["n"].(string))
			previousID, previousPresent = id, present
		}
		if j > i+1 {
			units := utf16.Encode([]rune(text.String()))
			name := text.String()
			if len(units) > 500 {
				truncated = true
				name = string(utf16.Decode(units[:499])) + "…"
			}
			first["n"] = name
		}
		result = append(result, first)
		i = j - 1
	}
	return result, truncated
}

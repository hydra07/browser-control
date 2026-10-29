package main

import (
	"fmt"
	"maps"
	"strings"
)

const defaultSnapshotLimit = 80

type semanticEntry struct {
	line string
	node any
}

func snapshotOmitted(shown, total int) string {
	return fmt.Sprintf("\n(%d of %d nodes shown; narrow --grep/--region, raise --limit, or --limit 0 for all)", shown, total)
}

func includeSnapshotLine(line, needle string, shown, limit int) bool {
	return (needle == "" || strings.Contains(strings.ToLower(line), needle)) && (limit == 0 || shown < limit)
}

/** Output views retain revision/scope but explicitly mark omissions; the extension still stores the complete ref state. */
func snapshotViewData(source map[string]any, shown, total int) map[string]any {
	view := maps.Clone(source)
	delete(view, "message")
	view["shown"], view["total"] = shown, total
	view["viewFiltered"] = shown < total
	return view
}

func semanticSnapshotView(snap map[string]any, grep string, limit int) output {
	entries := semanticEntries(snap, grep == "")
	var lines []string
	nodes := make([]any, 0, len(entries))
	needle := strings.ToLower(grep)
	for _, entry := range entries {
		if includeSnapshotLine(entry.line, needle, len(nodes), limit) {
			lines = append(lines, entry.line)
			nodes = append(nodes, entry.node)
		}
	}
	header := "doc " + str(asMap(snap["scope"])["documentId"])
	if title := str(snap["title"]); title != "" {
		header += " | " + truncate(title, 80)
	}
	if url := str(snap["url"]); url != "" {
		header += " | " + truncate(url, 200)
	}
	text := header + "\n" + strings.Join(lines, "\n")
	if len(nodes) < len(entries) {
		text += snapshotOmitted(len(nodes), len(entries))
	}
	if snap["truncated"] == true {
		text += "\n(snapshot truncated by the extension; use 'snapshot --region <css>')"
	}
	view := snapshotViewData(snap, len(nodes), len(entries))
	view["nodes"] = nodes
	return output{data: view, text: text}
}

func snapshotDeltaView(delta map[string]any, grep string, limit int) output {
	view := maps.Clone(delta)
	var lines []string
	total := 0
	needle := strings.ToLower(grep)
	refs := make(map[string]bool)
	for _, group := range []struct{ key, prefix string }{{"added", "+ "}, {"changed", "~ "}, {"removed", "- "}} {
		selected := []any{}
		for _, value := range asSlice(delta[group.key]) {
			total++
			ref := str(value)
			line := group.prefix + ref
			if group.key != "removed" {
				ref = str(asMap(value)["ref"])
				line = group.prefix + formatSemanticNode(asMap(value))
			}
			if includeSnapshotLine(line, needle, len(lines), limit) {
				selected = append(selected, value)
				lines = append(lines, line)
				refs[ref] = true
			}
		}
		view[group.key] = selected
	}
	uncertain := []any{}
	for _, ref := range asSlice(delta["uncertainRefs"]) {
		if refs[str(ref)] {
			uncertain = append(uncertain, ref)
		}
	}
	view["uncertainRefs"] = uncertain
	view = snapshotViewData(view, len(lines), total)
	header := fmt.Sprintf("doc %s diff %s→%s", str(asMap(delta["scope"])["documentId"]), str(delta["fromRevision"]), str(delta["toRevision"]))
	text := header + "\n" + strings.Join(lines, "\n")
	if total == 0 {
		text = header + ": no changes"
	} else if len(lines) == 0 {
		text = header + ": no matching changes"
	}
	if len(lines) < total {
		text += snapshotOmitted(len(lines), total)
	}
	if delta["truncated"] == true {
		text += "\n(diff truncated; run 'snapshot --semantic' for the full state)"
	}
	return output{data: view, text: text}
}

func regionSnapshotView(res map[string]any, grep string, limit int) output {
	var lines []string
	total := 0
	needle := strings.ToLower(grep)
	var visit func([]any, int) []any
	visit = func(nodes []any, depth int) []any {
		selected := []any{}
		for _, value := range nodes {
			total++
			node := asMap(value)
			line := strings.Repeat(" ", min(depth, 8)) + formatEntry(node)
			keep := includeSnapshotLine(line, needle, len(lines), limit)
			if keep {
				lines = append(lines, line)
			}
			children := visit(asSlice(node["children"]), depth+1)
			if keep {
				copy := maps.Clone(node)
				delete(copy, "children")
				if len(children) > 0 {
					copy["children"] = children
				}
				selected = append(selected, copy)
			} else {
				selected = append(selected, children...)
			}
		}
		return selected
	}
	tree := visit(asSlice(res["tree"]), 0)
	view := snapshotViewData(res, len(lines), total)
	view["tree"] = tree
	text := strings.Join(lines, "\n")
	if text == "" {
		text = "(no matching nodes in region)"
	}
	if len(lines) < total {
		text += snapshotOmitted(len(lines), total)
	}
	if res["truncated"] == true {
		text += "\n(truncated; use a narrower selector)"
	}
	return output{data: view, text: text}
}

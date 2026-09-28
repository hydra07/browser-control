package browser

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/go-rod/rod"
)

type SnapshotNode struct {
	ID       int    `json:"id"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	Value    string `json:"value,omitempty"`
	Tag      string `json:"tag"`
	Type     string `json:"type,omitempty"`
	Selector string `json:"selector,omitempty"`
}

const snapshotScript = `
() => {
    window.__bc_elements = [];
    const elements = document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"]), h1, h2, h3');
    const result = [];
    let id = 1;

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getAccessibleName(el) {
        return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.title || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').substring(0, 150);
    }

    function getRole(el) {
        return el.getAttribute('role') || el.tagName.toLowerCase();
    }

    for (const el of elements) {
        if (!isVisible(el)) continue;
        const name = getAccessibleName(el);
        const role = getRole(el);
        const tag = el.tagName.toLowerCase();
        const value = el.value !== undefined ? String(el.value) : '';

        // Generate a concise selector
        let sel = tag;
        if (el.id) sel += '#' + el.id;
        else if (el.className && typeof el.className === 'string') {
            const firstClass = el.className.trim().split(/\s+/)[0];
            if (firstClass && !firstClass.includes(':')) sel += '.' + firstClass;
        }

        window.__bc_elements[id] = el;
        result.push({
            id: id,
            role: role,
            name: name,
            value: value,
            tag: tag,
            type: el.type || '',
            selector: sel
        });
        id++;
        if (id > 200) break;
    }
    return result;
}
`

// TakeSnapshot captures interactive and semantic elements on the current page.
func TakeSnapshot(page *rod.Page) ([]SnapshotNode, error) {
	val, err := page.Eval(snapshotScript)
	if err != nil {
		return nil, fmt.Errorf("failed to evaluate snapshot script: %w", err)
	}

	var nodes []SnapshotNode
	bytes, err := json.Marshal(val.Value.Val())
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(bytes, &nodes); err != nil {
		return nil, err
	}
	return nodes, nil
}

// FormatSnapshotCompact formats the snapshot nodes in a high-density, token-efficient 1-line-per-node view.
func FormatSnapshotCompact(nodes []SnapshotNode) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Found %d interactive/semantic elements:\n", len(nodes)))
	for _, n := range nodes {
		valPart := ""
		if n.Value != "" {
			valPart = fmt.Sprintf(" val=%q", n.Value)
		}
		sb.WriteString(fmt.Sprintf("[%d] <%s role=%s> %q%s\n", n.ID, n.Tag, n.Role, n.Name, valPart))
	}
	return sb.String()
}

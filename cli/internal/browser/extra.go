package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-rod/rod"
)

type FindMatch struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
}

type FindResult struct {
	Query   string      `json:"query"`
	Matches []FindMatch `json:"matches"`
}

func Find(page *rod.Page, query string, limit int) (*FindResult, error) {
	if limit <= 0 {
		limit = 20
	}
	script := fmt.Sprintf(`() => {
  const query = %s.toLowerCase();
  const limit = %d;
  const nodes = Array.from(document.querySelectorAll('body *'));
  const out = [];
  const seen = new Set();
  function visible(el) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }
  for (const el of nodes) {
    if (out.length >= limit) break;
    if (!visible(el)) continue;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 800 || !text.toLowerCase().includes(query)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ index: out.length + 1, text });
  }
  return { query, matches: out };
}`, js(query), limit)
	var result FindResult
	if err := evalInto(page, script, &result); err != nil {
		return nil, err
	}
	result.Query = query
	return &result, nil
}

type SelectedContentItem struct {
	Index    int    `json:"index"`
	Tag      string `json:"tag"`
	Selector string `json:"selector,omitempty"`
	Text     string `json:"text"`
}

type SelectedContent struct {
	Selector string                `json:"selector"`
	Count    int                   `json:"count"`
	Items    []SelectedContentItem `json:"items"`
}

func SelectContent(page *rod.Page, selector string, maxChars, maxMatches int) (*SelectedContent, error) {
	if maxChars <= 0 {
		maxChars = 20000
	}
	if maxMatches <= 0 {
		maxMatches = 20
	}
	script := fmt.Sprintf(`() => {
  const selector = %s;
  const maxChars = %d;
  const maxMatches = %d;
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, maxMatches);
  const items = nodes.map((el, i) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) sel += '.' + el.className.trim().split(/\s+/)[0];
    return { index: i + 1, tag: el.tagName.toLowerCase(), selector: sel, text };
  });
  return { selector, count: items.length, items };
}`, js(selector), maxChars, maxMatches)
	var result SelectedContent
	if err := evalInto(page, script, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

type ElementInspection struct {
	Target     string         `json:"target"`
	Tag        string         `json:"tag"`
	Role       string         `json:"role,omitempty"`
	Name       string         `json:"name,omitempty"`
	Text       string         `json:"text,omitempty"`
	Attributes map[string]any `json:"attributes"`
	Rect       map[string]any `json:"rect"`
	Visible    bool           `json:"visible"`
}

func InspectElement(page *rod.Page, target string) (*ElementInspection, error) {
	el, err := ResolveElement(page, target)
	if err != nil {
		return nil, err
	}
	_ = el.ScrollIntoView()
	var result ElementInspection
	script := fmt.Sprintf(`(el) => {
  const attrs = {};
  for (const a of Array.from(el.attributes || [])) attrs[a.name] = a.value;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    target: %s,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || text.slice(0, 150),
    text,
    attributes: attrs,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right },
    visible: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
  };
}`, js(target))
	val, err := el.Eval(script)
	if err != nil {
		return nil, fmt.Errorf("inspect element: %w", err)
	}
	if err := decodeVal(val.Value.Val(), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func Drag(page *rod.Page, fromX, fromY, toX, toY float64) (*ActionResult, error) {
	script := fmt.Sprintf(`() => {
  const fromX = %f, fromY = %f, toX = %f, toY = %f;
  const target = document.elementFromPoint(fromX, fromY) || document.body;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: fromX, clientY: fromY, button: 0 };
  target.dispatchEvent(new MouseEvent('mousemove', opts));
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  const moveTarget = document.elementFromPoint(toX, toY) || target;
  moveTarget.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: toX, clientY: toY }));
  moveTarget.dispatchEvent(new MouseEvent('mouseup', { ...opts, clientX: toX, clientY: toY }));
  moveTarget.dispatchEvent(new MouseEvent('click', { ...opts, clientX: toX, clientY: toY }));
  return true;
}`, fromX, fromY, toX, toY)
	if _, err := page.Eval(script); err != nil {
		return nil, fmt.Errorf("drag failed: %w", err)
	}
	return &ActionResult{Success: true, Message: fmt.Sprintf("Dragged from %.0f,%.0f to %.0f,%.0f", fromX, fromY, toX, toY)}, nil
}

type NetworkEntry struct {
	Name            string  `json:"name"`
	InitiatorType   string  `json:"initiatorType"`
	StartTime       float64 `json:"startTime"`
	Duration        float64 `json:"duration"`
	TransferSize    float64 `json:"transferSize"`
	EncodedBodySize float64 `json:"encodedBodySize"`
	DecodedBodySize float64 `json:"decodedBodySize"`
}

func NetworkEntries(page *rod.Page, filter string, limit int) ([]NetworkEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	script := fmt.Sprintf(`() => {
  const filter = %s.toLowerCase();
  const limit = %d;
  return performance.getEntriesByType('resource')
    .filter(e => !filter || e.name.toLowerCase().includes(filter) || e.initiatorType.toLowerCase().includes(filter))
    .slice(-limit)
    .map(e => ({
      name: e.name,
      initiatorType: e.initiatorType,
      startTime: e.startTime,
      duration: e.duration,
      transferSize: e.transferSize || 0,
      encodedBodySize: e.encodedBodySize || 0,
      decodedBodySize: e.decodedBodySize || 0
    }));
}`, js(filter), limit)
	var entries []NetworkEntry
	if err := evalInto(page, script, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func HAR(page *rod.Page, filter string, limit int) (map[string]any, error) {
	entries, err := NetworkEntries(page, filter, limit)
	if err != nil {
		return nil, err
	}
	harEntries := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		harEntries = append(harEntries, map[string]any{
			"request":        map[string]any{"url": e.Name, "method": "GET"},
			"response":       map[string]any{"status": 0, "bodySize": e.DecodedBodySize},
			"time":           e.Duration,
			"_initiatorType": e.InitiatorType,
			"_transferSize":  e.TransferSize,
		})
	}
	return map[string]any{"log": map[string]any{"version": "1.2", "creator": map[string]string{"name": "browsercontrol-cli", "version": "headless"}, "entries": harEntries}}, nil
}

func ClearPerformanceEntries(page *rod.Page) (*ActionResult, error) {
	_, err := page.Eval(`() => { performance.clearResourceTimings(); return true; }`)
	if err != nil {
		return nil, err
	}
	return &ActionResult{Success: true, Message: "Cleared in-page performance resource entries"}, nil
}

func Layout(page *rod.Page, target string) (map[string]any, error) {
	el, err := ResolveElement(page, target)
	if err != nil {
		return nil, err
	}
	val, err := el.Eval(`(el) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right },
    display: cs.display,
    position: cs.position,
    zIndex: cs.zIndex,
    overflow: cs.overflow,
    boxSizing: cs.boxSizing,
    margin: { top: cs.marginTop, right: cs.marginRight, bottom: cs.marginBottom, left: cs.marginLeft },
    padding: { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft },
    border: { top: cs.borderTopWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth, left: cs.borderLeftWidth }
  };
}`)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := decodeVal(val.Value.Val(), &out); err != nil {
		return nil, err
	}
	out["target"] = target
	return out, nil
}

func Memory(page *rod.Page) (map[string]any, error) {
	var out map[string]any
	if err := evalInto(page, `() => {
  const mem = performance.memory || {};
  return {
    jsHeapSizeLimit: mem.jsHeapSizeLimit || null,
    totalJSHeapSize: mem.totalJSHeapSize || null,
    usedJSHeapSize: mem.usedJSHeapSize || null,
    resourceTimingEntries: performance.getEntriesByType('resource').length,
    domNodes: document.getElementsByTagName('*').length
  };
}`, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func Process(page *rod.Page) (map[string]any, error) {
	var out map[string]any
	if err := evalInto(page, `() => ({
  url: location.href,
  title: document.title,
  visibilityState: document.visibilityState,
  readyState: document.readyState,
  now: performance.now(),
  navigation: performance.getEntriesByType('navigation')[0] || null,
  resources: performance.getEntriesByType('resource').length
})`, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func Emulate(page *rod.Page, device string) (*ActionResult, error) {
	preset := strings.ToLower(strings.TrimSpace(device))
	if preset == "" {
		preset = "desktop"
	}
	width, height, dpr, mobile := 1365, 900, 1.0, false
	switch preset {
	case "iphone", "iphone12", "iphone-12", "mobile":
		width, height, dpr, mobile = 390, 844, 3, true
	case "ipad", "tablet":
		width, height, dpr, mobile = 820, 1180, 2, true
	case "desktop":
		width, height, dpr, mobile = 1365, 900, 1, false
	}
	page.MustSetViewport(width, height, dpr, mobile)
	return &ActionResult{Success: true, Message: fmt.Sprintf("Emulated %s viewport %dx%d dpr=%.1f mobile=%v", preset, width, height, dpr, mobile)}, nil
}

func Sandbox(page *rod.Page, mode string) (*ActionResult, error) {
	switch mode {
	case "block_mutations":
		_, err := page.Eval(`() => {
  if (window.__browsercontrolSandboxInstalled) return true;
  window.__browsercontrolSandboxInstalled = true;
  const block = () => { throw new Error('BrowserControl sandbox blocked a mutating network request'); };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) block();
    return originalFetch.apply(this, arguments);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) block();
    return originalOpen.apply(this, arguments);
  };
  return true;
}`)
		if err != nil {
			return nil, err
		}
		return &ActionResult{Success: true, Message: "Sandbox enabled: mutating fetch/XMLHttpRequest calls are blocked in page context"}, nil
	case "off":
		return &ActionResult{Success: true, Message: "Sandbox off requested; reload the page to restore patched APIs"}, nil
	default:
		return nil, fmt.Errorf("unknown sandbox mode %q", mode)
	}
}

func WriteJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil && filepath.Dir(path) != "." {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func evalInto(page *rod.Page, script string, out any) error {
	val, err := page.Eval(script)
	if err != nil {
		return err
	}
	return decodeVal(val.Value.Val(), out)
}

func decodeVal(value any, out any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func js(value string) string {
	data, _ := json.Marshal(value)
	return string(data)
}

package browser

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-rod/rod"
)

type RegionSnapshot struct {
	Selector string         `json:"selector"`
	Count    int            `json:"count"`
	Nodes    []SnapshotNode `json:"nodes"`
}

func QueryRegion(page *rod.Page, selector string, limit int) (*RegionSnapshot, error) {
	if limit <= 0 {
		limit = 100
	}
	script := fmt.Sprintf(`() => {
  const selector = %s;
  const limit = %d;
  const root = document.querySelector(selector);
  if (!root) throw new Error('region not found: ' + selector);
  window.__bc_elements = [];
  const candidates = root.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"]), h1, h2, h3');
  const out = [];
  function visible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }
  function name(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.title || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 150);
  }
  let id = 1;
  for (const el of candidates) {
    if (out.length >= limit) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    let sel = tag;
    if (el.id) sel += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) sel += '.' + el.className.trim().split(/\s+/)[0];
    window.__bc_elements[id] = el;
    out.push({ id, role: el.getAttribute('role') || tag, name: name(el), value: el.value !== undefined ? String(el.value) : '', tag, type: el.type || '', selector: sel });
    id++;
  }
  return { selector, count: out.length, nodes: out };
}`, js(selector), limit)
	var result RegionSnapshot
	if err := evalInto(page, script, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

type PeekScreenResult struct {
	Title         string         `json:"title"`
	URL           string         `json:"url"`
	ReadyState    string         `json:"readyState"`
	SelectionText string         `json:"selectionText,omitempty"`
	Text          string         `json:"text,omitempty"`
	TextChars     int            `json:"textChars"`
	Snapshot      []SnapshotNode `json:"snapshot,omitempty"`
	Screenshot    string         `json:"screenshot,omitempty"`
}

func PeekScreen(page *rod.Page, maxChars int, screenshotPath string) (*PeekScreenResult, error) {
	if maxChars <= 0 {
		maxChars = 8000
	}
	var meta struct {
		Title         string `json:"title"`
		URL           string `json:"url"`
		ReadyState    string `json:"readyState"`
		SelectionText string `json:"selectionText"`
	}
	if err := evalInto(page, `() => ({
  title: document.title || '',
  url: location.href || '',
  readyState: document.readyState || '',
  selectionText: String(getSelection ? getSelection() : '').trim()
})`, &meta); err != nil {
		return nil, err
	}
	reader, err := ExtractReadingMode(page, maxChars)
	if err != nil {
		return nil, err
	}
	nodes, _ := TakeSnapshot(page)
	result := &PeekScreenResult{
		Title:         meta.Title,
		URL:           meta.URL,
		ReadyState:    meta.ReadyState,
		SelectionText: meta.SelectionText,
		Text:          reader.Text,
		TextChars:     reader.Chars,
		Snapshot:      nodes,
	}
	if screenshotPath != "" {
		path, err := Screenshot(page, screenshotPath, false)
		if err != nil {
			return nil, err
		}
		result.Screenshot = path
	}
	return result, nil
}

type VisualSnapshotResult struct {
	Title      string         `json:"title"`
	URL        string         `json:"url"`
	Screenshot string         `json:"screenshot"`
	Nodes      []SnapshotNode `json:"nodes,omitempty"`
}

func VisualSnapshot(page *rod.Page, outputPath string, fullPage bool) (*VisualSnapshotResult, error) {
	path, err := Screenshot(page, outputPath, fullPage)
	if err != nil {
		return nil, err
	}
	info, _ := page.Info()
	nodes, _ := TakeSnapshot(page)
	result := &VisualSnapshotResult{Screenshot: path, Nodes: nodes}
	if info != nil {
		result.Title = info.Title
		result.URL = info.URL
	}
	return result, nil
}

type NetworkDetail struct {
	Index           int     `json:"index"`
	Name            string  `json:"name"`
	InitiatorType   string  `json:"initiatorType"`
	StartTime       float64 `json:"startTime"`
	Duration        float64 `json:"duration"`
	TransferSize    float64 `json:"transferSize"`
	EncodedBodySize float64 `json:"encodedBodySize"`
	DecodedBodySize float64 `json:"decodedBodySize"`
	BodyUnavailable bool    `json:"bodyUnavailable"`
	Hint            string  `json:"hint,omitempty"`
}

func NetworkEntryDetail(page *rod.Page, target string, includeBody bool) (*NetworkDetail, error) {
	entries, err := NetworkEntries(page, "", 1000)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("no in-page performance network entries; run after navigation or use net trace in a future persistent capture mode")
	}
	idx := -1
	if n, err := strconv.Atoi(strings.TrimSpace(target)); err == nil && n >= 1 && n <= len(entries) {
		idx = n - 1
	} else {
		needle := strings.ToLower(target)
		for i, e := range entries {
			if strings.Contains(strings.ToLower(e.Name), needle) || strings.Contains(strings.ToLower(e.InitiatorType), needle) {
				idx = i
				break
			}
		}
	}
	if idx < 0 {
		return nil, fmt.Errorf("no network entry matching %q", target)
	}
	e := entries[idx]
	return &NetworkDetail{
		Index:           idx + 1,
		Name:            e.Name,
		InitiatorType:   e.InitiatorType,
		StartTime:       e.StartTime,
		Duration:        e.Duration,
		TransferSize:    e.TransferSize,
		EncodedBodySize: e.EncodedBodySize,
		DecodedBodySize: e.DecodedBodySize,
		BodyUnavailable: includeBody,
		Hint:            "This headless CLI mode reads browser PerformanceResourceTiming entries. Response bodies/status/headers require a live CDP Network capture started before navigation.",
	}, nil
}

type CrawlResult struct {
	URL    string `json:"url"`
	Title  string `json:"title,omitempty"`
	Text   string `json:"text,omitempty"`
	Chars  int    `json:"chars,omitempty"`
	Error  string `json:"error,omitempty"`
	Millis int64  `json:"millis"`
}

func BatchCrawl(b *rod.Browser, urls []string, concurrency int, maxChars int) ([]CrawlResult, error) {
	if concurrency <= 0 {
		concurrency = 3
	}
	if maxChars <= 0 {
		maxChars = 12000
	}
	jobs := make(chan string)
	results := make(chan CrawlResult, len(urls))
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rawURL := range jobs {
				started := time.Now()
				res := CrawlResult{URL: rawURL}
				page := b.MustPage("")
				if nav, err := Navigate(page, rawURL); err != nil {
					res.Error = err.Error()
				} else {
					_ = nav
					if read, err := ExtractReadingMode(page, maxChars); err != nil {
						res.Error = err.Error()
					} else {
						res.Title = read.Title
						res.Text = read.Text
						res.Chars = read.Chars
					}
				}
				_ = page.Close()
				res.Millis = time.Since(started).Milliseconds()
				results <- res
			}
		}()
	}
	for _, value := range urls {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			jobs <- trimmed
		}
	}
	close(jobs)
	wg.Wait()
	close(results)
	out := make([]CrawlResult, 0, len(urls))
	for item := range results {
		out = append(out, item)
	}
	return out, nil
}

type SearchResult struct {
	Index int    `json:"index"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type WebSearchResult struct {
	Query   string         `json:"query"`
	Engine  string         `json:"engine"`
	Results []SearchResult `json:"results"`
}

func WebSearch(page *rod.Page, query string, limit int) (*WebSearchResult, error) {
	if limit <= 0 {
		limit = 10
	}
	searchURL := "https://duckduckgo.com/html/?q=" + url.QueryEscape(query)
	if _, err := Navigate(page, searchURL); err != nil {
		return nil, err
	}
	time.Sleep(750 * time.Millisecond)
	script := fmt.Sprintf(`() => {
  const limit = %d;
  const links = Array.from(document.querySelectorAll('a.result__a, a[data-testid="result-title-a"], a[href]'));
  const seen = new Set();
  const out = [];
  for (const a of links) {
    if (out.length >= limit) break;
    const title = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
    const href = a.href || '';
    if (!title || !href || href.startsWith('javascript:') || seen.has(href)) continue;
    seen.add(href);
    out.push({ index: out.length + 1, title, url: href });
  }
  return { query: %s, engine: 'duckduckgo-html', results: out };
}`, limit, js(query))
	var result WebSearchResult
	if err := evalInto(page, script, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

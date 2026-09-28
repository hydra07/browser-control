package browser

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/go-rod/rod"
)

type TabInfo struct {
	ID     string `json:"id"`
	Index  int    `json:"index"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Active bool   `json:"active"`
}

// ListTabs returns all open pages/tabs in the browser.
func ListTabs(b *rod.Browser) ([]TabInfo, error) {
	pages, err := b.Pages()
	if err != nil {
		return nil, fmt.Errorf("failed to query browser pages: %w", err)
	}

	var result []TabInfo
	for i, p := range pages {
		info, err := p.Info()
		if err != nil {
			continue
		}
		// Skip internal devtools or background targets
		if strings.HasPrefix(info.URL, "devtools://") {
			continue
		}
		result = append(result, TabInfo{
			ID:     string(info.TargetID),
			Index:  i + 1,
			Title:  info.Title,
			URL:    info.URL,
			Active: i == 0,
		})
	}
	return result, nil
}

// ResolvePage finds a specific page by TargetID, 1-based index, or returns the active/first page.
func ResolvePage(b *rod.Browser, target string) (*rod.Page, error) {
	pages, err := b.Pages()
	if err != nil {
		return nil, fmt.Errorf("failed to get pages: %w", err)
	}
	if len(pages) == 0 {
		return b.MustPage(""), nil
	}

	if target == "" {
		return pages[0], nil
	}

	// Try 1-based numeric index first (e.g. "1", "2")
	if idx, err := strconv.Atoi(target); err == nil && idx >= 1 && idx <= len(pages) {
		return pages[idx-1], nil
	}

	// Try matching TargetID or prefix
	for _, p := range pages {
		info, err := p.Info()
		if err != nil {
			continue
		}
		if string(info.TargetID) == target || strings.HasPrefix(string(info.TargetID), target) {
			return p, nil
		}
	}

	// Fallback to first page
	return pages[0], nil
}

// SwitchTab activates a tab by ID or index.
func SwitchTab(b *rod.Browser, target string) (*TabInfo, error) {
	page, err := ResolvePage(b, target)
	if err != nil {
		return nil, err
	}
	if _, err := page.Activate(); err != nil {
		return nil, fmt.Errorf("failed to activate tab: %w", err)
	}
	info, err := page.Info()
	if err != nil {
		return nil, err
	}
	return &TabInfo{
		ID:     string(info.TargetID),
		Title:  info.Title,
		URL:    info.URL,
		Active: true,
	}, nil
}

// CloseTab closes a tab by ID or index.
func CloseTab(b *rod.Browser, target string) error {
	page, err := ResolvePage(b, target)
	if err != nil {
		return err
	}
	return page.Close()
}

// NewTab creates a new tab with the given URL (or blank).
func NewTab(b *rod.Browser, url string) (*rod.Page, *TabInfo, error) {
	p := b.MustPage(url)
	if err := p.WaitLoad(); err != nil {
		// Non-fatal, SPA might not have traditional load
	}
	info, err := p.Info()
	if err != nil {
		return p, nil, err
	}
	return p, &TabInfo{
		ID:     string(info.TargetID),
		Title:  info.Title,
		URL:    info.URL,
		Active: true,
	}, nil
}

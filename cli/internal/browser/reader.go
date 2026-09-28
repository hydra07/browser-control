package browser

import (
	"fmt"
	"strings"

	"github.com/go-rod/rod"
)

type ReaderResult struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	Text  string `json:"text"`
	Chars int    `json:"chars"`
}

const readerScript = `
() => {
    // Clone body to manipulate without disturbing the live DOM
    const clone = document.body.cloneNode(true);
    
    // Remove noise elements
    const unwanted = clone.querySelectorAll('script, style, noscript, svg, nav, footer, header, [role="navigation"], [role="banner"], [aria-hidden="true"], .nav, .footer, .sidebar');
    unwanted.forEach(el => el.remove());

    // Extract headings and paragraphs
    const main = clone.querySelector('main, article, [role="main"]') || clone;
    
    let text = main.innerText || '';
    // Normalize extra linebreaks
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    
    return {
        title: document.title || '',
        url: window.location.href || '',
        text: text,
        chars: text.length
    };
}
`

// ExtractReadingMode extracts clean readable text from the current page.
func ExtractReadingMode(page *rod.Page, maxChars int) (*ReaderResult, error) {
	val, err := page.Eval(readerScript)
	if err != nil {
		return nil, fmt.Errorf("failed to extract page text: %w", err)
	}

	resMap, ok := val.Value.Val().(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected evaluation result format")
	}

	title, _ := resMap["title"].(string)
	url, _ := resMap["url"].(string)
	text, _ := resMap["text"].(string)

	if maxChars > 0 && len(text) > maxChars {
		text = text[:maxChars] + "\n\n... [Content truncated at maxChars limit]"
	}

	return &ReaderResult{
		Title: title,
		URL:   url,
		Text:  strings.TrimSpace(text),
		Chars: len(text),
	}, nil
}

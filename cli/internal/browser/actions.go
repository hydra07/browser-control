package browser

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

type ActionResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

// Navigate loads a URL on the given page and waits for it to stabilize.
func Navigate(page *rod.Page, url string) (*ActionResult, error) {
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "about:") && !strings.HasPrefix(url, "chrome://") {
		url = "https://" + url
	}
	if err := page.Navigate(url); err != nil {
		return nil, fmt.Errorf("navigation failed: %w", err)
	}
	_ = page.WaitLoad()
	info, _ := page.Info()
	title := ""
	if info != nil {
		title = info.Title
	}
	return &ActionResult{
		Success: true,
		Message: fmt.Sprintf("Navigated to %s (%s)", url, title),
	}, nil
}

// ResolveElement finds an element on the page by snapshot numeric ID, CSS selector, or accessible text.
func ResolveElement(page *rod.Page, target string) (*rod.Element, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, fmt.Errorf("target identifier cannot be empty")
	}

	// 1. Check if target is a numeric ID from a prior snapshot (e.g. "12")
	if id, err := strconv.Atoi(target); err == nil && id > 0 {
		hasEl, err := page.Eval(fmt.Sprintf(`() => !!(window.__bc_elements && window.__bc_elements[%d])`, id))
		if err == nil && hasEl.Value.Bool() {
			el, err := page.ElementByJS(rod.Eval(fmt.Sprintf(`() => window.__bc_elements[%d]`, id)))
			if err == nil && el != nil {
				return el, nil
			}
		}
	}

	// 2. If it looks like a CSS selector (#id, .class, [attr], tag), try finding by selector
	if strings.HasPrefix(target, "#") || strings.HasPrefix(target, ".") || strings.HasPrefix(target, "[") || strings.Contains(target, ">") || strings.Contains(target, " ") {
		el, err := page.Element(target)
		if err == nil && el != nil {
			return el, nil
		}
	}

	// 3. Try standard CSS selector
	el, err := page.Element(target)
	if err == nil && el != nil {
		return el, nil
	}

	// 4. Fallback: Search element by visible text / regex
	el, err = page.ElementR("button, a, input, [role='button']", target)
	if err == nil && el != nil {
		return el, nil
	}

	return nil, fmt.Errorf("could not resolve element matching %q (try running 'snapshot' first to get numeric IDs)", target)
}

// Click finds an element and simulates a trusted click event.
func Click(page *rod.Page, target string) (*ActionResult, error) {
	el, err := ResolveElement(page, target)
	if err != nil {
		return nil, err
	}
	if err := el.ScrollIntoView(); err != nil {
		// Non-fatal
	}
	if err := el.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return nil, fmt.Errorf("failed to click element %q: %w", target, err)
	}
	return &ActionResult{
		Success: true,
		Message: fmt.Sprintf("Clicked element %q", target),
	}, nil
}

// Type inputs text into the resolved element.
func Type(page *rod.Page, target, text string, clear bool) (*ActionResult, error) {
	el, err := ResolveElement(page, target)
	if err != nil {
		return nil, err
	}
	if err := el.Focus(); err != nil {
		// Non-fatal
	}
	if clear {
		if err := el.SelectAllText(); err == nil {
			_ = page.Keyboard.Press(input.Backspace)
		}
	}
	if err := el.Input(text); err != nil {
		return nil, fmt.Errorf("failed to type into element %q: %w", target, err)
	}
	return &ActionResult{
		Success: true,
		Message: fmt.Sprintf("Typed %d characters into %q", len(text), target),
	}, nil
}

// PressKey dispatches a keyboard key press event.
func PressKey(page *rod.Page, keyName string) (*ActionResult, error) {
	keyMap := map[string]input.Key{
		"enter":     input.Enter,
		"return":    input.Enter,
		"tab":       input.Tab,
		"escape":    input.Escape,
		"esc":       input.Escape,
		"backspace": input.Backspace,
		"delete":    input.Delete,
		"space":     input.Space,
		"up":        input.ArrowUp,
		"down":      input.ArrowDown,
		"left":      input.ArrowLeft,
		"right":     input.ArrowRight,
		"pageup":    input.PageUp,
		"pagedown":  input.PageDown,
	}

	lower := strings.ToLower(strings.TrimSpace(keyName))
	if k, ok := keyMap[lower]; ok {
		if err := page.Keyboard.Press(k); err != nil {
			return nil, fmt.Errorf("failed to press key %q: %w", keyName, err)
		}
	} else if len(keyName) == 1 {
		if err := page.InsertText(keyName); err != nil {
			return nil, fmt.Errorf("failed to press character %q: %w", keyName, err)
		}
	} else {
		return nil, fmt.Errorf("unknown key %q (supported: Enter, Tab, Escape, Backspace, Space, ArrowUp, ArrowDown...)", keyName)
	}

	return &ActionResult{
		Success: true,
		Message: fmt.Sprintf("Pressed key %s", keyName),
	}, nil
}

// Scroll scrolls the viewport by the specified pixel deltas.
func Scroll(page *rod.Page, deltaX, deltaY float64) (*ActionResult, error) {
	if err := page.Mouse.Scroll(deltaX, deltaY, 5); err != nil {
		return nil, fmt.Errorf("failed to scroll: %w", err)
	}
	return &ActionResult{
		Success: true,
		Message: fmt.Sprintf("Scrolled by deltaX=%.0f, deltaY=%.0f", deltaX, deltaY),
	}, nil
}

// Screenshot takes a visual screenshot of the viewport or full page.
func Screenshot(page *rod.Page, outputPath string, fullPage bool) (string, error) {
	if outputPath == "" {
		cacheDir := filepath.Join(os.Getenv("USERPROFILE"), ".browsercontrol", "screenshots")
		_ = os.MkdirAll(cacheDir, 0755)
		outputPath = filepath.Join(cacheDir, fmt.Sprintf("screenshot-%d.jpg", time.Now().UnixMilli()))
	} else {
		_ = os.MkdirAll(filepath.Dir(outputPath), 0755)
	}

	var data []byte
	var err error
	if fullPage {
		data, err = page.Screenshot(true, &proto.PageCaptureScreenshot{
			Format: proto.PageCaptureScreenshotFormatJpeg,
		})
	} else {
		data, err = page.Screenshot(false, &proto.PageCaptureScreenshot{
			Format: proto.PageCaptureScreenshotFormatJpeg,
		})
	}
	if err != nil {
		return "", fmt.Errorf("failed to capture screenshot: %w", err)
	}

	if err := os.WriteFile(outputPath, data, 0644); err != nil {
		return "", fmt.Errorf("failed to save screenshot to %s: %w", outputPath, err)
	}
	return outputPath, nil
}

// Eval evaluates a JavaScript expression and returns the raw output.
func Eval(page *rod.Page, expression string) (interface{}, error) {
	val, err := page.Eval(expression)
	if err != nil {
		return nil, fmt.Errorf("JavaScript evaluation error: %w", err)
	}
	return val.Value.Val(), nil
}

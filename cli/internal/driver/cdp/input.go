package cdp

import (
	"context"
	"errors"
	"math"
	"time"
	"unicode/utf8"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

type inputPair struct {
	method string
	down   any
	up     any
}

type keyEvent struct {
	Type                  string `json:"type"`
	Key                   string `json:"key"`
	Code                  string `json:"code,omitempty"`
	WindowsVirtualKeyCode int    `json:"windowsVirtualKeyCode,omitempty"`
	Text                  string `json:"text,omitempty"`
	Modifiers             int    `json:"modifiers"`
}

// Press dispatches a bounded chord; callers must persist intent before invoking input methods.
func (t *Target) Press(ctx context.Context, keys []driver.Key) (result driver.ActionResult, err error) {
	result = driver.NewAction(driver.Press)
	defer func() { result.FinishedAt = time.Now().UnixMilli() }()
	if len(keys) < 1 || len(keys) > 8 {
		return result, errors.New("key chord requires 1–8 keys")
	}
	plan := make([]inputPair, 0, len(keys))
	modifiers := 0
	seen := map[string]bool{}
	for i, key := range keys {
		modifier := keyModifier(key.Key)
		if key.Key == "" || len(key.Key) > 64 || len(key.Code) > 64 || len(key.Text) > 64 || key.VirtualKey < 0 || key.VirtualKey > 255 ||
			seen[key.Key] || i < len(keys)-1 && modifier == 0 || modifier != 0 && key.Text != "" {
			return result, errors.New("invalid or duplicate key in chord")
		}
		seen[key.Key] = true
		before := modifiers
		modifiers |= modifier
		if key.Text == "" {
			if key.Key == "Enter" {
				key.Text = "\r"
			} else if utf8.RuneCountInString(key.Key) == 1 {
				key.Text = key.Key
			}
		}
		if modifiers&7 != 0 {
			key.Text = ""
		}
		down := keyEvent{Type: "keyDown", Key: key.Key, Code: key.Code, WindowsVirtualKeyCode: key.VirtualKey, Text: key.Text, Modifiers: modifiers}
		up := keyEvent{Type: "keyUp", Key: key.Key, Code: key.Code, WindowsVirtualKeyCode: key.VirtualKey, Modifiers: before}
		plan = append(plan, inputPair{method: "Input.dispatchKeyEvent", down: down, up: up})
	}
	return t.runInput(ctx, plan, result)
}

func keyModifier(key string) int {
	switch key {
	case "Alt":
		return 1
	case "Control":
		return 2
	case "Meta":
		return 4
	case "Shift":
		return 8
	}
	return 0
}

func (t *Target) Click(ctx context.Context, point driver.Point) (result driver.ActionResult, err error) {
	result = driver.NewAction(driver.Click)
	defer func() { result.FinishedAt = time.Now().UnixMilli() }()
	if math.IsNaN(point.X) || math.IsNaN(point.Y) || math.IsInf(point.X, 0) || math.IsInf(point.Y, 0) || point.X < 0 || point.Y < 0 {
		return result, errors.New("click requires finite nonnegative coordinates")
	}
	return t.runInput(ctx, []inputPair{{method: "Input.dispatchMouseEvent",
		down: map[string]any{"type": "mousePressed", "x": point.X, "y": point.Y, "button": "left", "buttons": 1, "clickCount": 1},
		up:   map[string]any{"type": "mouseReleased", "x": point.X, "y": point.Y, "button": "left", "buttons": 0, "clickCount": 1}}}, result)
}

func (t *Target) InsertText(ctx context.Context, text string) (result driver.ActionResult, err error) {
	result = driver.NewAction(driver.InsertText)
	defer func() { result.FinishedAt = time.Now().UnixMilli() }()
	if len(text) > 1024*1024 {
		return result, errors.New("text exceeds input limit")
	}
	return t.runInput(ctx, []inputPair{{method: "Input.insertText", down: map[string]any{"text": text}}}, result)
}

func (t *Target) runInput(ctx context.Context, plan []inputPair, result driver.ActionResult) (driver.ActionResult, error) {
	if err := ctx.Err(); err != nil {
		result.Status = driver.Cancelled
		return result, err
	}
	if !t.valid.Load() {
		return result, ErrDetached
	}
	select {
	case t.input <- struct{}{}:
		defer func() { <-t.input }()
	case <-ctx.Done():
		result.Status = driver.Cancelled
		return result, ctx.Err()
	}
	var held []inputPair
	var dispatchErr, cleanupErr error
	unknown := false
	completed := 0
	for _, pair := range plan {
		if err := ctx.Err(); err != nil {
			dispatchErr = err
			break
		}
		var receipt writeReceipt
		err := t.callWithReceipt(ctx, pair.method, pair.down, nil, &receipt)
		var command *CommandError
		attempted := err == nil || errors.As(err, &command) && command.Written
		if attempted {
			result.Dispatched = true
			result.InputState = driver.WriteAttempted
			if result.DispatchedAt == nil {
				result.DispatchedAt = &receipt.attemptedAt
			}
			if pair.up != nil {
				held = append(held, pair)
			}
			unknown = unknown || err != nil
		}
		if err != nil {
			dispatchErr = err
			break
		}
		completed++
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	for i := len(held) - 1; i >= 0; i-- {
		pair := held[i]
		if err := t.call(cleanup, pair.method, pair.up, nil); err != nil {
			result.CleanupComplete = false
			cleanupErr = errors.Join(cleanupErr, err)
		}
	}
	result.Acknowledged = result.Dispatched && !unknown && result.CleanupComplete
	if result.Acknowledged {
		result.InputState = driver.Acknowledged
	}
	switch {
	case unknown || !result.CleanupComplete:
		result.Status = driver.OutcomeUnknown
	case completed == len(plan):
		result.Status = driver.Completed
	case errors.Is(dispatchErr, context.Canceled) || errors.Is(dispatchErr, context.DeadlineExceeded):
		result.Status = driver.Cancelled
	}
	return result, errors.Join(dispatchErr, cleanupErr)
}

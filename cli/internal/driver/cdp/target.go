package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sync/atomic"
)

var ErrDetached = errors.New("Chrome target detached; session handles are invalid")

type TargetInfo struct {
	ID    string `json:"targetId"`
	Type  string `json:"type"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type Target struct {
	client  *Client
	id      string
	session string
	valid   atomic.Bool
	input   chan struct{}
}

type World struct {
	target    *Target
	contextID int
}

type EvaluationError struct {
	Description string
}

func (e *EvaluationError) Error() string { return "Chrome evaluation failed: " + e.Description }

func (c *Client) Version(ctx context.Context) (string, error) {
	var result struct{ Product string }
	err := c.call(ctx, "", "Browser.getVersion", nil, &result)
	return result.Product, err
}

func (c *Client) Targets(ctx context.Context) ([]TargetInfo, error) {
	var result struct{ TargetInfos []TargetInfo }
	err := c.call(ctx, "", "Target.getTargets", nil, &result)
	return result.TargetInfos, err
}

func (c *Client) NewPage(ctx context.Context, pageURL string) (*Target, error) {
	u, err := url.Parse(pageURL)
	if err != nil || u.User != nil || (pageURL != "about:blank" && ((u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "")) {
		return nil, errors.New("new page requires an HTTP(S) URL without credentials, or about:blank")
	}
	var result struct{ TargetID string }
	if err := c.call(ctx, "", "Target.createTarget", map[string]any{"url": pageURL}, &result); err != nil {
		return nil, err
	}
	if result.TargetID == "" {
		return nil, errors.New("Chrome did not return a created target ID")
	}
	target, err := c.Attach(ctx, result.TargetID)
	if err != nil {
		return &Target{client: c, id: result.TargetID}, fmt.Errorf("tab %s was created but attach failed: %w; inspect before creating another", result.TargetID, err)
	}
	return target, nil
}

func (c *Client) Attach(ctx context.Context, id string) (*Target, error) {
	if id == "" {
		return nil, errors.New("missing Chrome target ID")
	}
	var result struct{ SessionID string }
	if err := c.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": id, "flatten": true}, &result); err != nil {
		return nil, err
	}
	if result.SessionID == "" {
		return nil, errors.New("Chrome did not return an attached session")
	}
	target := &Target{client: c, id: id, session: result.SessionID, input: make(chan struct{}, 1)}
	target.valid.Store(true)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		target.valid.Store(false)
		return nil, c.err
	}
	if c.detached[result.SessionID] {
		delete(c.detached, result.SessionID)
		target.valid.Store(false)
		return nil, ErrDetached
	}
	c.targets[result.SessionID] = target
	return target, nil
}

func (t *Target) ID() string { return t.id }

func (t *Target) Close(ctx context.Context) error {
	if !t.valid.Swap(false) {
		return nil
	}
	err := t.client.call(ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": t.session}, nil)
	t.client.mu.Lock()
	delete(t.client.targets, t.session)
	t.client.mu.Unlock()
	return err
}

func (t *Target) call(ctx context.Context, method string, params, out any) error {
	return t.callWithReceipt(ctx, method, params, out, nil)
}

func (t *Target) callWithReceipt(ctx context.Context, method string, params, out any, receipt *writeReceipt) error {
	if !t.valid.Load() {
		return ErrDetached
	}
	return t.client.callWithReceipt(ctx, t.session, method, params, out, receipt)
}

func (t *Target) IsolatedWorld(ctx context.Context, name string) (*World, error) {
	if name == "" {
		return nil, errors.New("isolated world must have a name")
	}
	var tree struct {
		FrameTree struct{ Frame struct{ ID string } }
	}
	if err := t.call(ctx, "Page.getFrameTree", nil, &tree); err != nil {
		return nil, err
	}
	if tree.FrameTree.Frame.ID == "" {
		return nil, errors.New("Chrome returned no main frame")
	}
	var result struct{ ExecutionContextID int }
	if err := t.call(ctx, "Page.createIsolatedWorld", map[string]any{"frameId": tree.FrameTree.Frame.ID, "worldName": name}, &result); err != nil {
		return nil, err
	}
	if result.ExecutionContextID == 0 {
		return nil, errors.New("Chrome returned no execution context")
	}
	return &World{target: t, contextID: result.ExecutionContextID}, nil
}

func (w *World) Evaluate(ctx context.Context, expression string) (json.RawMessage, error) {
	var result struct {
		Result struct {
			Value               json.RawMessage
			UnserializableValue string
			Type                string
		}
		ExceptionDetails *struct {
			Text      string
			Exception *struct{ Description string }
		}
	}
	if err := w.target.call(ctx, "Runtime.evaluate", map[string]any{"contextId": w.contextID, "expression": expression, "returnByValue": true, "awaitPromise": true}, &result); err != nil {
		return nil, err
	}
	if detail := result.ExceptionDetails; detail != nil {
		description := detail.Text
		if detail.Exception != nil && detail.Exception.Description != "" {
			description = detail.Exception.Description
		}
		return nil, &EvaluationError{Description: description}
	}
	if len(result.Result.Value) == 0 {
		return nil, fmt.Errorf("Chrome returned no serializable evaluation value (%s)", result.Result.Type)
	}
	return result.Result.Value, nil
}

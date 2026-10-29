package cdp

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

//go:embed agent.js
var agentScript string

const agentWorld = "browsercontrol-direct-agent-v1"

func (c *Client) Pages(ctx context.Context) ([]driver.PageInfo, error) {
	targets, err := c.Targets(ctx)
	if err != nil {
		return nil, err
	}
	pages := make([]driver.PageInfo, 0)
	for _, target := range targets {
		if target.Type == "page" {
			pages = append(pages, driver.PageInfo{ID: target.ID, Title: target.Title, URL: target.URL})
		}
	}
	return pages, nil
}

func (c *Client) AttachPage(ctx context.Context, id string) (driver.AgentPage, error) {
	return c.Attach(ctx, id)
}

func mutation(ctx context.Context, kind driver.ActionKind, call func(*writeReceipt) error) (result driver.ActionResult, err error) {
	result = driver.NewAction(kind)
	defer func() { result.FinishedAt = time.Now().UnixMilli() }()
	if err = ctx.Err(); err != nil {
		result.Status = driver.Cancelled
		return
	}
	var receipt writeReceipt
	err = call(&receipt)
	var command *CommandError
	if receipt.attemptedAt > 0 || err == nil || errors.As(err, &command) && command.Written {
		result.Dispatched = true
		result.InputState = driver.WriteAttempted
		result.DispatchedAt = &receipt.attemptedAt
		result.Status = driver.OutcomeUnknown
	}
	if err == nil {
		result.Status = driver.Completed
		result.Acknowledged = true
		result.InputState = driver.Acknowledged
	}
	return
}

func (c *Client) OpenBlank(ctx context.Context) (driver.AgentPage, driver.ActionResult, error) {
	var created struct{ TargetID string }
	result, err := mutation(ctx, driver.CreateTab, func(receipt *writeReceipt) error {
		return c.callWithReceipt(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created, receipt)
	})
	if err != nil {
		return nil, result, err
	}
	if created.TargetID == "" {
		result.Status = driver.OutcomeUnknown
		return nil, result, errors.New("tab creation unconfirmed; do not repeat")
	}
	page, err := c.Attach(ctx, created.TargetID)
	return page, result, err
}

func (c *Client) RemovePage(ctx context.Context, id string) (driver.ActionResult, error) {
	return mutation(ctx, driver.CloseTab, func(receipt *writeReceipt) error {
		return c.callWithReceipt(ctx, "", "Target.closeTarget", map[string]any{"targetId": id}, nil, receipt)
	})
}

func (t *Target) agentEvaluate(ctx context.Context, request map[string]any, out any) error {
	request["seed"] = rand.Text()
	encoded, err := json.Marshal(request)
	if err != nil {
		return err
	}
	world, err := t.IsolatedWorld(ctx, agentWorld)
	if err != nil {
		return err
	}
	value, err := world.Evaluate(ctx, agentScript+"\nbrowserControlAgent("+string(encoded)+")")
	if err != nil {
		return errors.New(privacy.NewScrubber(nil).Text(err.Error()))
	}
	return json.Unmarshal(value, out)
}

func (t *Target) Snapshot(ctx context.Context) (driver.AgentSnapshot, error) {
	var snapshot driver.AgentSnapshot
	err := t.agentEvaluate(ctx, map[string]any{"op": "snapshot"}, &snapshot)
	if err != nil {
		return snapshot, err
	}
	scrub := privacy.NewScrubber(nil)
	snapshot.URL = scrub.URL(snapshot.URL)
	snapshot.Title = scrub.Text(snapshot.Title)
	for i := range snapshot.Nodes {
		snapshot.Nodes[i].Name = scrub.Text(snapshot.Nodes[i].Name)
		snapshot.Nodes[i].Value = scrub.Text(snapshot.Nodes[i].Value)
	}
	return snapshot, nil
}

func (t *Target) CheckOrigin(ctx context.Context, origins []string) error {
	var allowed bool
	return t.agentEvaluate(ctx, map[string]any{"op": "guard", "origins": origins}, &allowed)
}

func (t *Target) Navigate(ctx context.Context, pageURL string) (driver.ActionResult, error) {
	u, err := url.Parse(pageURL)
	if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		result := driver.NewAction(driver.Navigate)
		result.FinishedAt = time.Now().UnixMilli()
		return result, errors.New("open requires an HTTP(S) URL without credentials")
	}
	var reply struct {
		ErrorText string
		LoaderID  string
	}
	result, err := mutation(ctx, driver.Navigate, func(receipt *writeReceipt) error {
		return t.callWithReceipt(ctx, "Page.navigate", map[string]any{"url": pageURL}, &reply, receipt)
	})
	if err != nil {
		return result, err
	}
	if reply.ErrorText != "" {
		result.Status = driver.Failed
		return result, errors.New("navigation failed: " + reply.ErrorText)
	}
	ready, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		var complete bool
		if err := t.agentEvaluate(ready, map[string]any{"op": "ready"}, &complete); err == nil && complete {
			return result, nil
		}
		select {
		case <-ready.Done():
			return result, errors.New("navigation acknowledged but readiness was not observed; inspect snapshot before retrying")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (t *Target) Act(ctx context.Context, request driver.AgentRequest) (result driver.ActionResult, err error) {
	kind := driver.Click
	if request.Operation == "type" {
		kind = driver.InsertText
	}
	if request.Operation == "scroll" {
		kind = driver.Scroll
	}
	result = driver.NewAction(kind)
	defer func() {
		if result.FinishedAt == 0 {
			result.FinishedAt = time.Now().UnixMilli()
		}
	}()
	if err = ctx.Err(); err != nil {
		result.Status = driver.Cancelled
		return
	}
	if request.Operation == "scroll" {
		world, worldErr := t.IsolatedWorld(ctx, agentWorld)
		if worldErr != nil {
			return result, worldErr
		}
		data, _ := json.Marshal(map[string]any{"op": "scroll", "x": request.X, "y": request.Y, "seed": rand.Text(), "origins": request.Origins})
		var reply struct{ ExceptionDetails json.RawMessage }
		return mutation(ctx, kind, func(receipt *writeReceipt) error {
			err := t.callWithReceipt(ctx, "Runtime.evaluate", map[string]any{"contextId": world.contextID, "expression": agentScript + "\nbrowserControlAgent(" + string(data) + ")", "returnByValue": true}, &reply, receipt)
			if err == nil && len(reply.ExceptionDetails) > 0 {
				return errors.New("scroll outcome unconfirmed")
			}
			return err
		})
	}
	params := map[string]any{"target": request.Target, "epoch": request.Epoch, "origins": request.Origins}
	if request.Operation == "click" {
		params["op"] = "point"
		var point driver.Point
		if err = t.agentEvaluate(ctx, params, &point); err != nil {
			return
		}
		return t.Click(ctx, point)
	}
	if request.Operation != "type" {
		return result, errors.New("unsupported action")
	}
	params["op"] = "focus"
	params["clear"] = request.Clear
	var focused struct{ OK bool }
	if err = t.agentEvaluate(ctx, params, &focused); err != nil {
		return
	}
	if !focused.OK {
		return result, errors.New("target could not be focused")
	}
	params["op"] = "focused"
	if err = t.agentEvaluate(ctx, params, &focused); err != nil || !focused.OK {
		return result, errors.New("stale_target: focus changed before text input")
	}
	if request.Clear && request.Text == "" {
		return t.Press(ctx, []driver.Key{{Key: "Backspace", Code: "Backspace", VirtualKey: 8}})
	}
	return t.InsertText(ctx, request.Text)
}

func (t *Target) ReadText(ctx context.Context, maxChars int) (string, error) {
	var text string
	err := t.agentEvaluate(ctx, map[string]any{"op": "read", "maxChars": maxChars}, &text)
	return privacy.NewScrubber(nil).Text(text), err
}

func (t *Target) Wait(ctx context.Context, query string) error {
	for {
		var found bool
		if err := t.agentEvaluate(ctx, map[string]any{"op": "wait", "text": query}, &found); err != nil {
			return err
		}
		if found {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("condition not observed before deadline: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (t *Target) Screenshot(ctx context.Context, full bool) ([]byte, error) {
	params := map[string]any{"format": "png", "captureBeyondViewport": full}
	if full {
		var metrics struct {
			CSSContentSize struct{ X, Y, Width, Height float64 }
		}
		if err := t.call(ctx, "Page.getLayoutMetrics", nil, &metrics); err != nil {
			return nil, err
		}
		if metrics.CSSContentSize.Width <= 0 || metrics.CSSContentSize.Height <= 0 || metrics.CSSContentSize.Width > 16384 || metrics.CSSContentSize.Height > 32768 {
			return nil, errors.New("full-page screenshot exceeds bounds")
		}
		params["clip"] = map[string]any{"x": 0, "y": 0, "width": metrics.CSSContentSize.Width, "height": metrics.CSSContentSize.Height, "scale": 1}
	}
	var reply struct{ Data string }
	if err := t.call(ctx, "Page.captureScreenshot", params, &reply); err != nil {
		return nil, err
	}
	if len(reply.Data) > 24<<20 {
		return nil, errors.New("screenshot exceeds artifact limit")
	}
	data, err := base64.StdEncoding.DecodeString(reply.Data)
	if err != nil || len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		return nil, errors.New("Chrome returned invalid PNG")
	}
	return data, nil
}

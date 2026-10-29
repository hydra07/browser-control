package cdp

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

const (
	captureWorld     = "browsercontrol-fixture-read"
	methodFrameTree  = "Page.getFrameTree"
	methodDOMCapture = "DOMSnapshot.captureSnapshot"
	methodAXCapture  = "Accessibility.getFullAXTree"
)

func (c *Client) CaptureFixture(ctx context.Context, request driver.CaptureRequest, claim func(context.Context, string) error) (driver.Capture, error) {
	if claim == nil {
		return driver.Capture{}, errors.New("fixture capture requires a tab lease")
	}
	u, err := url.Parse(request.URL)
	if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return driver.Capture{}, errors.New("fixture source requires an HTTP(S) URL without userinfo")
	}
	if request.MaxNodes == 0 {
		request.MaxNodes = 20000
	}
	if request.MaxFrames == 0 {
		request.MaxFrames = 32
	}
	if request.MaxNodes < 1 || request.MaxNodes > 100000 || request.MaxFrames < 1 || request.MaxFrames > 128 {
		return driver.Capture{}, errors.New("invalid fixture collection budget")
	}
	id := request.TargetID
	if request.Private {
		pages, err := c.Targets(ctx)
		if err != nil {
			return driver.Capture{}, errors.New("cannot list owned profile pages")
		}
		var matches []string
		for _, page := range pages {
			if page.Type == "page" && page.URL == request.URL && (id == "" || id == page.ID) {
				matches = append(matches, page.ID)
			}
		}
		if len(matches) != 1 {
			return driver.Capture{}, errors.New("private fixture requires one existing page matching the exact URL; disambiguate with --target")
		}
		id = matches[0]
	} else {
		if id != "" {
			return driver.Capture{}, errors.New("--target requires --allow-private")
		}
		var isolated struct{ BrowserContextID string }
		if err := c.call(ctx, "", "Target.createBrowserContext", map[string]any{"disposeOnDetach": true}, &isolated); err != nil || isolated.BrowserContextID == "" {
			return driver.Capture{}, errors.New("cannot create anonymous fixture context")
		}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = c.call(cleanup, "", "Target.disposeBrowserContext", map[string]any{"browserContextId": isolated.BrowserContextID}, nil)
		}()
		var created struct{ TargetID string }
		if err := c.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank", "browserContextId": isolated.BrowserContextID, "background": true}, &created); err != nil || created.TargetID == "" {
			return driver.Capture{}, errors.New("anonymous page creation unconfirmed; no replay was attempted")
		}
		id = created.TargetID
	}
	if err := claim(ctx, id); err != nil {
		return driver.Capture{}, err
	}
	target, err := c.Attach(ctx, id)
	if err != nil {
		return driver.Capture{}, errors.New("cannot attach fixture page")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = target.Close(cleanup)
	}()
	loader := ""
	if !request.Private {
		var navigation struct{ ErrorText, LoaderID string }
		if err := target.call(ctx, "Page.navigate", map[string]any{"url": request.URL}, &navigation); err != nil || navigation.ErrorText != "" {
			return driver.Capture{}, errors.New("fixture navigation unconfirmed; no replay was attempted")
		}
		loader = navigation.LoaderID
		if loader == "" {
			return driver.Capture{}, errors.New("fixture navigation has no confirmed document; no replay was attempted")
		}
	}
	if err := target.fixtureReady(ctx, request.RequireFixtureReady, loader); err != nil {
		return driver.Capture{}, err
	}
	var before struct{ FrameTree captureFrame }
	if err := target.call(ctx, methodFrameTree, nil, &before); err != nil {
		return driver.Capture{}, errors.New("cannot read fixture frame tree")
	}
	if request.Private && before.FrameTree.Frame.URL != request.URL {
		return driver.Capture{}, errors.New("private page navigated before capture")
	}
	if loader != "" && before.FrameTree.Frame.LoaderID != loader {
		return driver.Capture{}, errors.New("fixture document changed after readiness")
	}
	var dom captureDOM
	if err := target.call(ctx, methodDOMCapture, map[string]any{"computedStyles": []string{}}, &dom); err != nil {
		return driver.Capture{}, errors.New("cannot capture DOM within the transport budget")
	}
	frames := flattenCaptureFrames(before.FrameTree)
	if len(frames) == 0 || len(dom.Documents) == 0 {
		return driver.Capture{}, errors.New("fixture capture returned no document")
	}
	trees := make(map[string][]captureAXNode)
	var missing []string
	for i, frame := range frames {
		if i >= request.MaxFrames {
			missing = append(missing, frame.Frame.ID)
			continue
		}
		var ax struct{ Nodes []captureAXNode }
		if err := target.call(ctx, methodAXCapture, map[string]any{"frameId": frame.Frame.ID}, &ax); err != nil {
			if i == 0 {
				return driver.Capture{}, errors.New("cannot capture root accessibility tree")
			}
			missing = append(missing, frame.Frame.ID)
			continue
		}
		trees[frame.Frame.ID] = ax.Nodes
	}
	var after struct{ FrameTree captureFrame }
	if err := target.call(ctx, methodFrameTree, nil, &after); err != nil || frameIdentity(before.FrameTree) != frameIdentity(after.FrameTree) {
		return driver.Capture{}, errors.New("document changed during fixture capture; no file was published")
	}
	version, err := c.Version(ctx)
	if err != nil {
		return driver.Capture{}, errors.New("cannot identify fixture browser")
	}
	return sanitizeCapture(dom, frames, trees, missing, request.CaptureOptions, version)
}

func (t *Target) fixtureReady(ctx context.Context, builtIn bool, loader string) error {
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	expression := "document.readyState === 'complete'"
	if builtIn {
		expression += " && document.documentElement.dataset.fixtureReady === 'true'"
	}
	for {
		var current struct{ FrameTree captureFrame }
		if err := t.call(deadline, methodFrameTree, nil, &current); err == nil && (loader == "" || current.FrameTree.Frame.LoaderID == loader) {
			world, err := t.IsolatedWorld(deadline, captureWorld)
			if err == nil {
				if ready, err := world.Evaluate(deadline, expression); err == nil && string(ready) == "true" {
					return nil
				}
			}
		}
		select {
		case <-deadline.Done():
			return errors.New("fixture readiness was not observed before deadline")
		case <-ticker.C:
		}
	}
}

func flattenCaptureFrames(root captureFrame) []captureFrame {
	var frames []captureFrame
	var visit func(captureFrame, int)
	visit = func(frame captureFrame, depth int) {
		if depth > 128 || len(frames) >= 1024 {
			return
		}
		frames = append(frames, frame)
		for _, child := range frame.ChildFrames {
			visit(child, depth+1)
		}
	}
	visit(root, 0)
	return frames
}

func frameIdentity(root captureFrame) string {
	var identity strings.Builder
	for _, frame := range flattenCaptureFrames(root) {
		fmt.Fprintf(&identity, "%q/%q/%q;", frame.Frame.ID, frame.Frame.LoaderID, frame.Frame.URL)
	}
	return identity.String()
}

func newCaptureEpoch() string { return "fixture_" + rand.Text() }

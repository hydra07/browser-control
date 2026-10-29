package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

// BenchmarkProbe collects setup-only trace metadata without adding event retention to the runtime client.
type BenchmarkProbe struct {
	ws       *websocket.Conn
	next     int
	pageURL  string
	frames   map[string]int
	complete bool
	bytes    int
}

type BenchmarkProcess struct {
	ID      int     `json:"id"`
	Type    string  `json:"type"`
	CPUTime float64 `json:"cpuTime"`
}

type BenchmarkPage struct {
	TargetID    string
	RendererPID int
}

func OpenBenchmarkProbe(ctx context.Context, endpoint string) (*BenchmarkProbe, error) {
	if err := validateEndpoint(endpoint, false); err != nil {
		return nil, err
	}
	ws, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(16 << 20)
	return &BenchmarkProbe{ws: ws}, nil
}

func (p *BenchmarkProbe) Close() error { return p.ws.Close() }

func (p *BenchmarkProbe) call(ctx context.Context, session, method string, params, out any) error {
	p.next++
	id := p.next
	deadline := time.Now().Add(20 * time.Second)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_ = p.ws.SetWriteDeadline(deadline)
	_ = p.ws.SetReadDeadline(deadline)
	if err := p.ws.WriteJSON(map[string]any{"id": id, "sessionId": session, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		message, err := p.read()
		if err != nil {
			return fmt.Errorf("benchmark %s: %w", method, err)
		}
		if message.ID != id {
			continue
		}
		if message.Error != nil {
			return message.Error
		}
		if out != nil {
			return json.Unmarshal(message.Result, out)
		}
		return nil
	}
}

type benchmarkMessage struct {
	ID     int
	Method string
	Result json.RawMessage
	Params json.RawMessage
	Error  *ProtocolError
}

func (p *BenchmarkProbe) read() (benchmarkMessage, error) {
	_, data, err := p.ws.ReadMessage()
	if err != nil {
		return benchmarkMessage{}, err
	}
	var message benchmarkMessage
	if err := json.Unmarshal(data, &message); err != nil {
		return message, err
	}
	if p.frames != nil {
		p.bytes += len(data)
		if p.bytes > 32<<20 {
			return message, errors.New("benchmark setup trace exceeded 32 MiB")
		}
		if message.Method == "Tracing.dataCollected" {
			if err := p.collectFrames(message.Params); err != nil {
				return message, err
			}
		}
		if message.Method == "Tracing.tracingComplete" {
			p.complete = true
		}
	}
	return message, nil
}

func (p *BenchmarkProbe) collectFrames(params json.RawMessage) error {
	var batch struct {
		Value []struct {
			Name string
			Args json.RawMessage
		}
	}
	if err := json.Unmarshal(params, &batch); err != nil {
		return err
	}
	add := func(frame, url string, pid int) error {
		if url != p.pageURL || pid <= 0 || frame == "" {
			return nil
		}
		if old := p.frames[frame]; old != 0 && old != pid {
			return errors.New("benchmark page changed renderer during setup")
		}
		p.frames[frame] = pid
		return nil
	}
	for _, event := range batch.Value {
		if event.Name != "TracingStartedInBrowser" && event.Name != "FrameCommittedInBrowser" {
			continue
		}
		type frame struct {
			Frame     string
			URL       string
			ProcessID int
		}
		type frameData struct {
			frame
			Frames []frame
		}
		var args struct {
			frameData
			Data frameData
		}
		if err := json.Unmarshal(event.Args, &args); err != nil {
			return err
		}
		data := args.Data
		if data.Frame == "" && len(data.Frames) == 0 {
			data = args.frameData
		}
		if err := add(data.Frame, data.URL, data.ProcessID); err != nil {
			return err
		}
		for _, frame := range data.Frames {
			if err := add(frame.Frame, frame.URL, frame.ProcessID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *BenchmarkProbe) Targets(ctx context.Context) ([]TargetInfo, error) {
	var result struct{ TargetInfos []TargetInfo }
	err := p.call(ctx, "", "Target.getTargets", nil, &result)
	return result.TargetInfos, err
}

func (p *BenchmarkProbe) Processes(ctx context.Context) ([]BenchmarkProcess, error) {
	var result struct{ ProcessInfo []BenchmarkProcess }
	err := p.call(ctx, "", "SystemInfo.getProcessInfo", nil, &result)
	return result.ProcessInfo, err
}

func (p *BenchmarkProbe) Version(ctx context.Context) (string, error) {
	var result struct{ Product string }
	err := p.call(ctx, "", "Browser.getVersion", nil, &result)
	return result.Product, err
}

func (p *BenchmarkProbe) PageAttached(ctx context.Context, targetID string) (bool, error) {
	var result struct{ TargetInfo struct{ Attached bool } }
	err := p.call(ctx, "", "Target.getTargetInfo", map[string]any{"targetId": targetID}, &result)
	return result.TargetInfo.Attached, err
}

// IdentifyPage traces only navigation setup, then detaches before any measured interval.
func (p *BenchmarkProbe) IdentifyPage(ctx context.Context, pageURL string) (BenchmarkPage, error) {
	p.pageURL, p.frames, p.bytes, p.complete = pageURL, map[string]int{}, 0, false
	var created struct{ TargetID string }
	if err := p.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return BenchmarkPage{}, err
	}
	var attached struct{ SessionID string }
	if err := p.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return BenchmarkPage{}, err
	}
	if err := p.call(ctx, attached.SessionID, "Page.enable", nil, nil); err != nil {
		return BenchmarkPage{}, err
	}
	/** Browser-target tracing has no WebContents and emits empty frame metadata; use the page session. */
	if err := p.call(ctx, attached.SessionID, "Tracing.start", map[string]any{"categories": "disabled-by-default-devtools.timeline,devtools.timeline", "transferMode": "ReportEvents"}, nil); err != nil {
		return BenchmarkPage{}, err
	}
	if err := p.call(ctx, attached.SessionID, "Page.navigate", map[string]any{"url": pageURL}, nil); err != nil {
		return BenchmarkPage{}, err
	}
	var tree struct {
		FrameTree struct{ Frame struct{ ID, URL string } }
	}
	for attempt := 0; attempt < 100; attempt++ {
		if err := p.call(ctx, attached.SessionID, "Page.getFrameTree", nil, &tree); err != nil {
			return BenchmarkPage{}, err
		}
		if tree.FrameTree.Frame.URL == pageURL {
			break
		}
		select {
		case <-ctx.Done():
			return BenchmarkPage{}, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := p.call(ctx, attached.SessionID, "Tracing.end", nil, nil); err != nil {
		return BenchmarkPage{}, err
	}
	for !p.complete {
		if _, err := p.read(); err != nil {
			return BenchmarkPage{}, err
		}
	}
	pid := p.frames[tree.FrameTree.Frame.ID]
	p.frames = nil
	if pid == 0 || len(tree.FrameTree.Frame.ID) == 0 {
		return BenchmarkPage{}, errors.New("trace did not identify the exact fixture main-frame renderer")
	}
	if err := p.call(ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, nil); err != nil {
		return BenchmarkPage{}, err
	}
	targets, err := p.Targets(ctx)
	if err != nil {
		return BenchmarkPage{}, err
	}
	for _, target := range targets {
		if target.Type == "page" && target.ID != created.TargetID {
			if err := p.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": target.ID}, nil); err != nil {
				return BenchmarkPage{}, err
			}
		}
	}
	return BenchmarkPage{TargetID: created.TargetID, RendererPID: pid}, nil
}

func (p *BenchmarkProbe) CloseBrowser(ctx context.Context) error {
	return p.call(ctx, "", "Browser.close", nil, nil)
}

func (p *BenchmarkProbe) WorkerManifest(ctx context.Context, targetID string) (name, version string, err error) {
	var attached struct{ SessionID string }
	if err = p.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &attached); err != nil {
		return "", "", err
	}
	defer func() {
		detachErr := p.call(ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, nil)
		err = errors.Join(err, detachErr)
	}()
	var result struct {
		Result struct {
			Value struct{ Name, Version string }
		}
		ExceptionDetails json.RawMessage
	}
	const expression = `({name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version})`
	if err = p.call(ctx, attached.SessionID, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &result); err != nil {
		return "", "", err
	}
	if len(result.ExceptionDetails) != 0 {
		return "", "", errors.New("extension manifest evaluation failed")
	}
	return result.Result.Value.Name, result.Result.Value.Version, nil
}

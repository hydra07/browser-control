package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/session"
)

type sequenceProbe struct {
	Document string
	Nodes    []struct{ Key, Physical, Anchor string }
	Coverage devtools.SequenceCoverage
}

func TestChromeActionAndResumeSequences(t *testing.T) {
	chromeExecutable(t)
	for _, spec := range sequenceCases() {
		t.Run(spec.id, func(t *testing.T) { runChromeSequence(t, spec) })
	}
}

func runChromeSequence(t *testing.T, spec sequenceCase) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	endpoint, restart := sequenceBrowser(t, ctx, spec)
	origin, signals, releaseIdle := sequenceServer(t)
	uri := origin + "/sequence.html"
	target := sequencePage(t, ctx, endpoint, uri)
	sequenceWait(t, ctx, endpoint, target, "")
	if spec.mode != "" {
		sequenceEval(t, ctx, endpoint, target, "fixtureMode("+sequenceQuote(spec.mode)+"); true")
	}
	sequence := devtools.Sequence{SchemaVersion: 1, Classification: devtools.Synthetic, ID: spec.id, Kind: spec.kind, States: []devtools.SequenceState{}, Transitions: []devtools.SequenceTransition{}}
	browser := "browser-1"
	for i, stateSpec := range spec.states {
		state := sequenceCapture(t, ctx, endpoint, target, uri, browser, stateSpec)
		state.ID = fmt.Sprintf("s%d", i)
		sequence.States = append(sequence.States, state)
		if i == len(spec.steps) {
			break
		}
		step := spec.steps[i]
		sequence.Transitions = append(sequence.Transitions, devtools.SequenceTransition{From: state.ID, To: fmt.Sprintf("s%d", i+1), Trigger: string(step.op), Offline: step.op == sequenceIdle || step.op == sequenceRestart, Reopen: step.op == sequenceRestart, Expected: sequenceExpected(stateSpec, spec.states[i+1], step)})
		switch step.op {
		case sequenceClick, sequenceFill:
			sequenceInput(t, ctx, endpoint, target, step)
		case sequenceIdle:
			sequenceEval(t, ctx, endpoint, target, "fixtureIdle("+sequenceQuote(step.value)+","+sequenceQuote(spec.id)+"); true")
			// Both timers stay behind the last CDP detach and socket close.
			releaseIdle()
			select {
			case signal := <-signals:
				if signal != spec.id {
					t.Fatal("unexpected offline mutation witness")
				}
			case <-ctx.Done():
				t.Fatal("offline mutation signal not observed")
			}
		case sequenceReload:
			sequenceCommand(t, ctx, endpoint, target, "Page.reload", map[string]any{"ignoreCache": true})
			sequenceWait(t, ctx, endpoint, target, state.Document)
		case sequenceNavigate:
			sequenceInput(t, ctx, endpoint, target, sequenceStepSpec{op: sequenceClick, target: step.target})
			uri = origin + "/sequence.html?screen=report"
			sequenceWait(t, ctx, endpoint, target, state.Document)
		case sequenceRestart:
			endpoint = restart()
			browser = "browser-2"
			target = sequencePage(t, ctx, endpoint, uri)
			sequenceWait(t, ctx, endpoint, target, "")
		default:
			t.Fatal("unsupported sequence operation")
		}
	}
	if spec.kind == devtools.ResumeSequence && spec.steps[0].op == sequenceIdle {
		before, after := sequence.States[0], sequence.States[1]
		if spec.steps[0].value == "warm" {
			if after.Coverage.Revision <= before.Coverage.Revision || !slices.Contains(after.Coverage.History, "Intermediate update") || !slices.Contains(after.Coverage.History, "Updated while idle") || after.Coverage.Gap {
				t.Fatal("warm observer did not retain intermediate DOM evidence")
			}
		} else if spec.steps[0].value != "header" && (after.Coverage.ObserverActive || !after.Coverage.Gap || after.Coverage.Revision != before.Coverage.Revision) {
			t.Fatal("cold observer recorded mutations while disconnected")
		}
	}
	sequence = devtools.NormalizeSequence(sequence, origin)
	if err := devtools.ValidateSequence(sequence); err != nil {
		t.Fatal(err)
	}
	root, err := devtools.Worktree(ctx)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), spec.id+".json")
	if directory := os.Getenv("BROWSERCONTROL_SEQUENCE_OUTPUT"); directory != "" {
		out = filepath.Join(directory, spec.id+".json")
	} else if os.Getenv("BROWSERCONTROL_SEQUENCE_CREATE") == "1" {
		out = filepath.Join("fixtures", "synthetic", "sequences", spec.id+".json")
	}
	plan, err := devtools.PrepareOutput(ctx, root, out, devtools.Synthetic)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.WriteSequence(sequence); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(plan.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := devtools.ReadSequence(file); err != nil {
		t.Fatal(err)
	}
	t.Logf("states=%d transitions=%d provenance=%s", len(sequence.States), len(sequence.Transitions), sequence.Transitions[len(sequence.Transitions)-1].Expected.Provenance)
}

func sequenceBrowser(t *testing.T, ctx context.Context, spec sequenceCase) (string, func() string) {
	t.Helper()
	if spec.id != "resume-browser-restart" {
		h := startChrome(t)
		_ = h.client.ws.Close()
		return h.endpoint, nil
	}
	manager, err := session.NewBrowserManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	options := session.BrowserOptions{Profile: "agent", Executable: chromeExecutable(t), Headless: true, NoSandbox: runtime.GOOS == "linux" && (os.Geteuid() == 0 || os.Getenv("BROWSERCONTROL_E2E_NO_SANDBOX") == "1")}
	first, err := manager.Start(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := manager.Stop(cleanup, "agent"); err != nil {
			t.Error(err)
		}
	})
	return first.Endpoint, func() string {
		if _, err := manager.Stop(ctx, "agent"); err != nil {
			t.Fatal(err)
		}
		next, err := manager.Start(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		if next.ID == first.ID || next.Started == first.Started {
			t.Fatal("restart did not create a new owned Chrome process")
		}
		return next.Endpoint
	}
}

func sequenceServer(t *testing.T) (string, <-chan string, func()) {
	t.Helper()
	fixtures, err := devtools.StartFixtureServer()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fixtures.Close() })
	upstream, err := url.Parse(fixtures.BaseURL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	signals := make(chan string, 4)
	start := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(start) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__sequence_arm" {
			select {
			case <-start:
				w.WriteHeader(204)
			case <-r.Context().Done():
			}
			return
		}
		if r.URL.Path == "/__sequence_signal" {
			if r.Method != http.MethodPost || len(r.URL.Query().Get("name")) > 128 {
				w.WriteHeader(400)
				return
			}
			select {
			case signals <- r.URL.Query().Get("name"):
			default:
				w.WriteHeader(429)
				return
			}
			w.WriteHeader(204)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(func() { release(); server.Close() })
	return server.URL, signals, release
}

func sequencePage(t *testing.T, ctx context.Context, endpoint, uri string) string {
	t.Helper()
	client, err := cdp.Connect(ctx, endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	page, err := client.NewPage(ctx, uri)
	if err != nil {
		t.Fatal(err)
	}
	if err := page.Close(ctx); err != nil {
		t.Fatal(err)
	}
	return page.ID()
}

func sequenceWithPage(t *testing.T, ctx context.Context, endpoint, target string, work func(*testPage) error) error {
	t.Helper()
	client, err := dialTestConnection(ctx, endpoint)
	if err != nil {
		return err
	}
	defer client.ws.Close()
	var attached struct{ SessionID string }
	if err := client.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target, "flatten": true}, &attached); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.call(cleanup, "", "Target.detachFromTarget", map[string]any{"sessionId": attached.SessionID}, nil)
	}()
	page := &testPage{h: &chromeHarness{ctx: ctx}, client: client, targetID: target, session: attached.SessionID}
	return work(page)
}

func sequenceEval(t *testing.T, ctx context.Context, endpoint, target, expression string) json.RawMessage {
	t.Helper()
	var value json.RawMessage
	err := sequenceWithPage(t, ctx, endpoint, target, func(page *testPage) error { var err error; value, err = page.evaluate(0, expression); return err })
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func sequenceWait(t *testing.T, ctx context.Context, endpoint, target, oldDocument string) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var value json.RawMessage
		err := sequenceWithPage(t, deadline, endpoint, target, func(page *testPage) error {
			var err error
			value, err = page.evaluate(0, `document.readyState === 'complete' && typeof fixtureState === 'function' && fixtureState().document !== `+sequenceQuote(oldDocument))
			return err
		})
		if err == nil && string(value) == "true" {
			return
		}
		select {
		case <-deadline.Done():
			t.Fatal("sequence page/document not ready")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func sequenceCommand(t *testing.T, ctx context.Context, endpoint, target, method string, params any) {
	t.Helper()
	if err := sequenceWithPage(t, ctx, endpoint, target, func(page *testPage) error { return page.request(method, params, nil) }); err != nil {
		t.Fatal(err)
	}
}

func sequenceInput(t *testing.T, ctx context.Context, endpoint, target string, step sequenceStepSpec) {
	t.Helper()
	selector := sequenceQuote(`[data-testid="` + step.target + `"]`)
	err := sequenceWithPage(t, ctx, endpoint, target, func(page *testPage) (inputErr error) {
		if step.op == sequenceFill {
			if _, err := page.evaluate(0, `(()=>{const node=document.querySelector(`+selector+`);node.focus();node.select();return true})()`); err != nil {
				return err
			}
			return page.request("Input.insertText", map[string]any{"text": step.value}, nil)
		}
		value, err := page.evaluate(0, `(()=>{const node=document.querySelector(`+selector+`);node.scrollIntoView({block:'center'});const box=node.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`)
		if err != nil {
			return err
		}
		var point struct{ X, Y float64 }
		if err := json.Unmarshal(value, &point); err != nil {
			return err
		}
		params := map[string]any{"type": "mousePressed", "x": point.X, "y": point.Y, "button": "left", "buttons": 1, "clickCount": 1}
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			params["type"], params["buttons"] = "mouseReleased", 0
			inputErr = errors.Join(inputErr, page.client.call(cleanup, page.session, "Input.dispatchMouseEvent", params, nil))
		}()
		return page.request("Input.dispatchMouseEvent", params, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func sequenceCapture(t *testing.T, ctx context.Context, endpoint, target, uri, browser string, spec sequenceStateSpec) devtools.SequenceState {
	t.Helper()
	read := func() sequenceProbe {
		var probe sequenceProbe
		data := sequenceEval(t, ctx, endpoint, target, "fixtureState()")
		if err := json.Unmarshal(data, &probe); err != nil {
			t.Fatal(err)
		}
		return probe
	}
	before := read()
	client, err := cdp.Connect(ctx, endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := client.CaptureFixture(ctx, driver.CaptureRequest{URL: uri, TargetID: target, Private: true, CaptureOptions: driver.CaptureOptions{RequireFixtureReady: true}}, func(context.Context, string) error { return nil })
	_ = client.Close()
	if err != nil {
		t.Fatal(err)
	}
	after := read()
	if before.Document != after.Document || !reflect.DeepEqual(before.Nodes, after.Nodes) || before.Coverage.Revision != after.Coverage.Revision {
		t.Fatal("ground truth changed while collecting fixture")
	}
	state := devtools.SequenceState{Observation: devtools.SnapshotAt, Document: after.Document, Browser: browser, Snapshot: capture, Coverage: after.Coverage, Facts: spec.facts, Nodes: []devtools.SequenceNode{}}
	for _, key := range sequenceSortedKeys(spec.refs) {
		witness, err := devtools.WitnessNode(capture, key)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, node := range after.Nodes {
			if node.Key == key {
				state.Nodes = append(state.Nodes, devtools.SequenceNode{Key: key, Ref: spec.refs[key], Physical: node.Physical, Handle: witness.Handle, Anchor: node.Anchor})
				found = true
				break
			}
		}
		if !found {
			t.Fatal(errors.New("fixture physical witness missing"))
		}
	}
	return state
}

func sequenceQuote(value string) string { data, _ := json.Marshal(value); return string(data) }

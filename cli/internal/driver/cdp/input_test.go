package cdp

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

type inputRequest struct {
	ID     uint64
	Method string
	Params struct {
		Type, Key string
		Modifiers int
	}
}

func inputTarget(t *testing.T, handle func(*websocket.Conn)) (*Client, *Target) {
	t.Helper()
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		var request inputRequest
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		if request.Method != "Target.attachToTarget" {
			t.Errorf("unexpected first method: %s", request.Method)
			return
		}
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"sessionId": "input-test"}})
		handle(ws)
	})
	client, err := Connect(context.Background(), endpoint, Options{CallTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	target, err := client.Attach(context.Background(), "fixture")
	if err != nil {
		t.Fatal(err)
	}
	return client, target
}

func TestCancelledInputDispatchesNothing(t *testing.T) {
	client, target := inputTarget(t, func(ws *websocket.Conn) { _, _, _ = ws.ReadMessage() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, run := range []func() (driver.ActionResult, error){
		func() (driver.ActionResult, error) {
			return target.Press(ctx, []driver.Key{{Key: "a", Code: "KeyA", VirtualKey: 65, Text: "a"}})
		},
		func() (driver.ActionResult, error) { return target.Click(ctx, driver.Point{X: 10, Y: 20}) },
		func() (driver.ActionResult, error) { return target.InsertText(ctx, "fixture") },
	} {
		result, err := run()
		if !errors.Is(err, context.Canceled) || result.Status != driver.Cancelled || result.Dispatched {
			t.Fatalf("precancel: %+v %v", result, err)
		}
	}
	if calls := client.Stats().Calls; len(calls) != 1 || calls["Target.attachToTarget"] != 1 {
		t.Fatalf("input sent after cancellation: %+v", calls)
	}
}

func TestCancelWithUnacknowledgedKeyDownStillReleasesKey(t *testing.T) {
	down := make(chan struct{})
	up := make(chan string, 1)
	_, target := inputTarget(t, func(ws *websocket.Conn) {
		var request inputRequest
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		if request.Params.Type != "keyDown" {
			t.Errorf("unexpected input: %+v", request)
			return
		}
		close(down)
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		up <- request.Params.Type
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}})
		_, _, _ = ws.ReadMessage()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-down; cancel() }()
	result, err := target.Press(ctx, []driver.Key{{Key: "a", Code: "KeyA", VirtualKey: 65, Text: "a"}})
	if !errors.Is(err, context.Canceled) || result.Status != driver.OutcomeUnknown || !result.Dispatched || result.Acknowledged || !result.CleanupComplete {
		t.Fatalf("unknown key down: %+v %v", result, err)
	}
	select {
	case kind := <-up:
		if kind != "keyUp" {
			t.Fatalf("cleanup = %s", kind)
		}
	case <-time.After(time.Second):
		t.Fatal("held key was not released")
	}
}

func TestChordReleasesInReverseOrderAndTracksModifiers(t *testing.T) {
	var mu sync.Mutex
	var events []string
	_, target := inputTarget(t, func(ws *websocket.Conn) {
		for {
			var request inputRequest
			if err := ws.ReadJSON(&request); err != nil {
				return
			}
			mu.Lock()
			events = append(events, request.Params.Type+":"+request.Params.Key+":"+string(rune('0'+request.Params.Modifiers)))
			mu.Unlock()
			_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}})
		}
	})
	result, err := target.Press(context.Background(), []driver.Key{{Key: "Shift", Code: "ShiftLeft", VirtualKey: 16}, {Key: "A", Code: "KeyA", VirtualKey: 65, Text: "A"}})
	if err != nil || result.Status != driver.Completed || !result.Acknowledged || !result.CleanupComplete {
		t.Fatalf("chord: %+v %v", result, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(events, []string{"keyDown:Shift:8", "keyDown:A:8", "keyUp:A:8", "keyUp:Shift:0"}) {
		t.Fatalf("wrong modifier lifecycle: %+v", events)
	}
}

func TestInputCleanupFailureIsUnknownAndNeverReplayed(t *testing.T) {
	client, target := inputTarget(t, func(ws *websocket.Conn) {
		var request inputRequest
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}})
		_ = ws.ReadJSON(&request)
	})
	result, err := target.Click(context.Background(), driver.Point{X: 10, Y: 20})
	if err == nil || result.Status != driver.OutcomeUnknown || !result.Dispatched || result.CleanupComplete {
		t.Fatalf("lost release: %+v %v", result, err)
	}
	if calls := client.Stats().Calls["Input.dispatchMouseEvent"]; calls != 2 {
		t.Fatalf("input replayed: %d calls", calls)
	}
}

func TestCancelWhileAttachingCannotDispatchInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		var request inputRequest
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		cancel()
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"sessionId": "late-attach"}})
		_, _, _ = ws.ReadMessage()
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	target, err := client.Attach(ctx, "fixture")
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected attach error: %v", err)
	}
	if err == nil {
		if _, err := target.Click(ctx, driver.Point{X: 10, Y: 20}); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel lost after attach: %v", err)
		}
	}
	if calls := client.Stats().Calls; calls["Input.dispatchMouseEvent"] != 0 {
		t.Fatalf("input after cancelled attach: %+v", calls)
	}
}

func TestDeadlineStillReleasesAttemptedMouseDown(t *testing.T) {
	client, target := inputTarget(t, func(ws *websocket.Conn) {
		var request inputRequest
		if ws.ReadJSON(&request) != nil {
			return
		}
		if request.Params.Type != "mousePressed" {
			t.Errorf("unexpected down: %s", request.Params.Type)
			return
		}
		if ws.ReadJSON(&request) != nil {
			return
		}
		if request.Params.Type != "mouseReleased" {
			t.Errorf("unexpected release: %s", request.Params.Type)
			return
		}
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}})
		_, _, _ = ws.ReadMessage()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result, err := target.Click(ctx, driver.Point{X: 1, Y: 2})
	if !errors.Is(err, context.DeadlineExceeded) || result.Status != driver.OutcomeUnknown || !result.CleanupComplete || result.Validate() != nil {
		t.Fatalf("deadline cleanup: %+v %v", result, err)
	}
	if calls := client.Stats().Calls["Input.dispatchMouseEvent"]; calls != 2 {
		t.Fatalf("mouse release missing/replayed: %d", calls)
	}
}

package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
)

func TestChromeCancelledKeyDownIsReleasedAndNotReplayed(t *testing.T) {
	h := startChrome(t)
	page := h.open(t, "/controls.html")
	ctx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	proxy := dropFirstKeyDownAcknowledgement(t, h.endpoint, cancel)
	client, err := cdp.Connect(h.ctx, proxy, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	target, err := client.Attach(h.ctx, page.targetID)
	if err != nil {
		t.Fatal(err)
	}
	world, err := target.IsolatedWorld(h.ctx, "cancel-input-test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = world.Evaluate(h.ctx, `globalThis.__bcKeyEvents=[]; document.querySelector('input').focus(); for (const type of ['keydown','keyup']) addEventListener(type,e=>globalThis.__bcKeyEvents.push({type:e.type,key:e.key,shift:e.shiftKey})); true`)
	if err != nil {
		t.Fatal(err)
	}
	result, err := target.Press(ctx, []driver.Key{{Key: "Shift", Code: "ShiftLeft", VirtualKey: 16}})
	if !errors.Is(err, context.Canceled) || result.Status != driver.OutcomeUnknown || !result.Dispatched || result.Acknowledged || !result.CleanupComplete {
		t.Fatalf("cancelled down: %+v %v", result, err)
	}
	result, err = target.Press(h.ctx, []driver.Key{{Key: "a", Code: "KeyA", VirtualKey: 65, Text: "a"}})
	if err != nil || result.Status != driver.Completed {
		t.Fatalf("subsequent key: %+v %v", result, err)
	}
	value, err := world.Evaluate(h.ctx, `({value:document.querySelector('input').value,events:globalThis.__bcKeyEvents})`)
	if err != nil {
		t.Fatal(err)
	}
	var observed struct {
		Value  string
		Events []struct {
			Type, Key string
			Shift     bool
		}
	}
	if err := json.Unmarshal(value, &observed); err != nil {
		t.Fatal(err)
	}
	if observed.Value != "a" || len(observed.Events) != 4 || observed.Events[0].Key != "Shift" || observed.Events[1].Type != "keyup" || observed.Events[1].Key != "Shift" || observed.Events[2].Shift {
		t.Fatalf("key stuck or replayed: %s", value)
	}
	if calls := client.Stats().Calls["Input.dispatchKeyEvent"]; calls != 4 {
		t.Fatalf("input replayed: %d calls", calls)
	}
}

func dropFirstKeyDownAcknowledgement(t *testing.T, endpoint string, cancel context.CancelFunc) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		front, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer front.Close()
		back, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer back.Close()
		var downID atomic.Uint64
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer front.Close()
			for {
				kind, data, err := back.ReadMessage()
				if err != nil {
					return
				}
				var reply struct{ ID uint64 }
				if json.Unmarshal(data, &reply) == nil && reply.ID != 0 && reply.ID == downID.Load() {
					cancel()
					continue
				}
				if front.WriteMessage(kind, data) != nil {
					return
				}
			}
		}()
		for {
			kind, data, err := front.ReadMessage()
			if err != nil {
				break
			}
			var request struct {
				ID     uint64
				Method string
				Params struct{ Type string }
			}
			if json.Unmarshal(data, &request) == nil && request.Method == "Input.dispatchKeyEvent" && request.Params.Type == "keyDown" {
				downID.CompareAndSwap(0, request.ID)
			}
			if back.WriteMessage(kind, data) != nil {
				break
			}
		}
		_ = back.Close()
		<-done
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/devtools/browser/input-proxy"
}

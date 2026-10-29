package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func fakeChrome(t *testing.T, handle func(*websocket.Conn)) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		handle(conn)
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/devtools/browser/test"
}

func TestClientCorrelatesOutOfOrderRepliesWithoutEnablingDomains(t *testing.T) {
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		var requests [2]struct {
			ID     uint64
			Method string
		}
		for i := range requests {
			if err := ws.ReadJSON(&requests[i]); err != nil {
				t.Error(err)
				return
			}
		}
		for i := 1; i >= 0; i-- {
			_ = ws.WriteJSON(map[string]any{"id": requests[i].ID, "result": map[string]any{"method": requests[i].Method}})
		}
		_, _, _ = ws.ReadMessage()
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	results := make(chan error, 2)
	for _, method := range []string{"Browser.getVersion", "Target.getTargets"} {
		go func() {
			var result struct{ Method string }
			err := client.call(context.Background(), "", method, nil, &result)
			if err == nil && result.Method != method {
				err = errors.New("reply went to another caller")
			}
			results <- err
		}()
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if len(client.Stats().Calls) != 2 {
		t.Fatalf("unexpected domains/requests: %+v", client.Stats())
	}
}

func TestCancelledRequestIsNotWrittenOrReplayed(t *testing.T) {
	var writes atomic.Int32
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
			writes.Add(1)
		}
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = client.call(ctx, "", "Input.dispatchMouseEvent", nil, nil)
	var command *CommandError
	if !errors.As(err, &command) || command.Written || writes.Load() != 0 {
		t.Fatalf("precancel: %v, writes=%d", err, writes.Load())
	}
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	err = client.call(ctx, "", "Input.dispatchMouseEvent", nil, nil)
	cancel()
	if !errors.As(err, &command) || !command.Written || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("sent action must remain unknown: %v", err)
	}
	_ = client.Close()
	if writes.Load() != 1 {
		t.Fatalf("unexpected replay: %d", writes.Load())
	}
}

func TestDisconnectFailsPendingCall(t *testing.T) {
	endpoint := fakeChrome(t, func(ws *websocket.Conn) { _, _, _ = ws.ReadMessage() })
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = client.call(ctx, "", "Input.dispatchKeyEvent", nil, nil)
	var command *CommandError
	if !errors.As(err, &command) || !command.Written || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("disconnect must fail promptly: %v", err)
	}
}

func TestResponseLimitFailsClosed(t *testing.T) {
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		var request struct{ ID uint64 }
		_ = ws.ReadJSON(&request)
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": strings.Repeat("x", 2048)})
	})
	client, err := Connect(context.Background(), endpoint, Options{MaxMessageBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.call(context.Background(), "", "Browser.getVersion", nil, new(json.RawMessage)); err == nil {
		t.Fatal("accepted oversized response")
	}
}

func TestAttachAlreadyDetachedReturnsError(t *testing.T) {
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		var request struct{ ID uint64 }
		_ = ws.ReadJSON(&request)
		_ = ws.WriteJSON(map[string]any{"method": "Target.detachedFromTarget", "params": map[string]any{"sessionId": "already-gone"}})
		_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"sessionId": "already-gone"}})
		_, _, _ = ws.ReadMessage()
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Attach(context.Background(), "fixture"); !errors.Is(err, ErrDetached) {
		t.Fatalf("detached session was registered as live: %v", err)
	}
}

package extension

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestClientCannotOverrideRequestIdentityOrDeadline(t *testing.T) {
	client, connect := startBridge(t)
	conn := connect(func(msg map[string]any) map[string]any {
		if msg["id"] == "spoof" || msg["deadline"] == float64(1) || msg["type"] != nil {
			t.Error("reserved envelope fields were overridden")
		}
		return map[string]any{"type": "result", "data": map[string]any{"success": true}}
	})
	defer conn.Close()
	if _, err := client.Execute("snapshot", map[string]any{"id": "spoof", "deadline": 1, "type": "cancel"}); err != nil {
		t.Fatal(err)
	}
}

func TestDeadlineSendsCancellation(t *testing.T) {
	client, connect := startBridge(t)
	cancelled := make(chan string, 1)
	conn := connect(func(msg map[string]any) map[string]any {
		if msg["type"] == "cancel" {
			cancelled <- msg["id"].(string)
		}
		return nil
	})
	defer conn.Close()
	_, err := client.Execute("run_flow", map[string]any{"timeoutMs": 20})
	if err == nil || !strings.Contains(err.Error(), "outcome unknown") {
		t.Fatalf("unexpected timeout: %v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("cancel was not sent")
	}
}

func TestCaptureBinaryFramesAreSavedIncludingFinalChunk(t *testing.T) {
	client, connect := startBridge(t)
	var conn *websocket.Conn
	conn = connect(func(msg map[string]any) map[string]any {
		if msg["cmd"] == "stop_capture" {
			payload := []byte("webm-first-and-final")
			packet := make([]byte, 8+len(payload))
			packet[0], packet[1], packet[2] = 0xbc, 1, 2
			binary.LittleEndian.PutUint32(packet[4:8], uint32(len(payload)))
			copy(packet[8:], payload)
			_ = conn.WriteMessage(websocket.BinaryMessage, packet)
		}
		return map[string]any{"type": "result", "data": map[string]any{"success": true, "isStreamed": true}}
	})
	defer conn.Close()
	if _, err := client.Execute("start_capture", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	data, err := client.Execute("stop_capture", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result map[string]any `json:"result"`
	}
	_ = json.Unmarshal(data, &reply)
	path, _ := reply.Result["dataPath"].(string)
	bytes, err := os.ReadFile(path)
	if err != nil || string(bytes) != "webm-first-and-final" {
		t.Fatalf("artifact: %q %v", bytes, err)
	}
}

func TestTokenIsNeverDisclosedByDefault(t *testing.T) {
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	t.Setenv("BROWSERCONTROL_AUTO_PAIR", "")
	server, _, _ := NewServer(Config{Token: testToken})
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()
	if _, err := dialExtension(t, ts.URL, "chrome-extension://forged", ""); err == nil {
		t.Fatal("origin alone must not disclose the bearer token")
	}
}

const testToken = "0123456789abcdef0123456789abcdef"

/** Starts a bridge on httptest and returns a client plus a function that connects a fake extension answering with reply. */
func startBridge(t *testing.T) (*Client, func(reply func(msg map[string]any) map[string]any) *websocket.Conn) {
	t.Helper()
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	server, _, err := NewServer(Config{Token: testToken, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	client, _, err := NewClient(Config{BaseURL: ts.URL, Token: testToken, Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	connect := func(reply func(msg map[string]any) map[string]any) *websocket.Conn {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.WriteJSON(map[string]any{"type": "hello", "protocolVersion": protocolVersion, "role": "extension", "token": testToken, "clientVersion": "9.9.9"}); err != nil {
			t.Fatal(err)
		}
		var ack map[string]any
		if err := conn.ReadJSON(&ack); err != nil || ack["type"] != "hello_ack" {
			t.Fatalf("handshake failed: %v %v", ack, err)
		}
		go func() {
			for {
				var msg map[string]any
				if err := conn.ReadJSON(&msg); err != nil {
					return
				}
				if res := reply(msg); res != nil {
					res["id"] = msg["id"]
					_ = conn.WriteJSON(res)
				}
			}
		}()
		return conn
	}
	return client, connect
}

func TestExecuteRoundTripsThroughExtension(t *testing.T) {
	client, connect := startBridge(t)

	_, err := client.Execute("snapshot", map[string]any{})
	var be *BridgeError
	if !errors.As(err, &be) || !be.NotConnected() {
		t.Fatalf("want not-connected bridge error before pairing, got %v", err)
	}

	conn := connect(func(msg map[string]any) map[string]any {
		return map[string]any{"type": "result", "data": map[string]any{"echo": msg["cmd"], "tabId": msg["tabId"]}}
	})
	defer conn.Close()

	data, err := client.Execute("snapshot", map[string]any{"tabId": 7})
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Result["echo"] != "snapshot" || reply.Result["tabId"] != float64(7) {
		t.Fatalf("unexpected result %v", reply.Result)
	}

	status, err := client.Status()
	if err != nil || !strings.Contains(string(status), `"extensionVersion":"9.9.9"`) {
		t.Fatalf("status should report the extension version: %s %v", status, err)
	}
}

func TestPendingRequestsFailWhenExtensionDisconnects(t *testing.T) {
	client, connect := startBridge(t)
	var conn *websocket.Conn
	conn = connect(func(map[string]any) map[string]any {
		_ = conn.Close()
		return nil
	})
	start := time.Now()
	_, err := client.Execute("click", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Fatalf("want disconnect error, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("disconnect should fail fast, took %s", time.Since(start))
	}
}

func TestFlowEndpointsShareTheCLIStore(t *testing.T) {
	client, _ := startBridge(t)
	body := `{"name":"Login Flow","domain":"example.com","steps":[{"action":"click","name":"Login","extra":1}]}`
	if _, err := client.request(http.MethodPost, "/flows", json.RawMessage(body)); err != nil {
		t.Fatal(err)
	}
	flow, err := GetFlow("login-flow")
	if err != nil {
		t.Fatal(err)
	}
	if flow.StepCount != 1 || !strings.Contains(string(flow.Steps[0]), `"extra"`) {
		t.Fatalf("steps must be stored verbatim: %+v", flow)
	}
	list, err := client.request(http.MethodGet, "/flows", nil)
	if err != nil || !strings.Contains(string(list), `"id":"login-flow"`) || strings.Contains(string(list), `"steps"`) {
		t.Fatalf("list should carry metadata only: %s %v", list, err)
	}
	if _, err := client.request(http.MethodDelete, "/flows/login-flow", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := GetFlow("login-flow"); err == nil {
		t.Fatal("flow should be gone")
	}
}

func TestRejectsBadToken(t *testing.T) {
	client, _ := startBridge(t)
	client.token = "wrong"
	if _, err := client.Status(); err == nil {
		t.Fatal("status must require the bearer token")
	}
}

func TestCORSPreflightForSidePanel(t *testing.T) {
	server, _, _ := NewServer(Config{Token: testToken})
	req := httptest.NewRequest(http.MethodOptions, "/flows", nil)
	req.Header.Set("Origin", "chrome-extension://abc")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abc" {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}

func dialExtension(t *testing.T, url, origin, token string) (map[string]any, error) {
	t.Helper()
	header := http.Header{}
	header.Set("Origin", origin)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http"), header)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "hello", "protocolVersion": protocolVersion, "role": "extension", "token": token}); err != nil {
		return nil, err
	}
	var ack map[string]any
	err = conn.ReadJSON(&ack)
	return ack, err
}

func TestAutoPairTrustsFirstExtensionOnly(t *testing.T) {
	t.Setenv("BROWSERCONTROL_AUTO_PAIR", "1")
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	t.Setenv("BROWSERCONTROL_EXTENSION_ID", "")
	server, _, err := NewServer(Config{Token: testToken})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	ack, err := dialExtension(t, ts.URL, "chrome-extension://ours", "")
	if err != nil || ack["token"] != testToken {
		t.Fatalf("first extension should be auto-paired with the token: %v %v", ack, err)
	}
	ack, err = dialExtension(t, ts.URL, "chrome-extension://ours", "stale-token")
	if err != nil || ack["token"] != testToken {
		t.Fatalf("a stale token from the trusted extension should be re-paired: %v %v", ack, err)
	}
	ack, err = dialExtension(t, ts.URL, "chrome-extension://ours", testToken)
	if err != nil || ack["token"] != nil {
		t.Fatalf("a correct token must not be echoed back: %v %v", ack, err)
	}
	if _, err := dialExtension(t, ts.URL, "chrome-extension://someone-else", ""); err == nil {
		t.Fatal("a different extension must not be auto-paired")
	}
	if _, err := dialExtension(t, ts.URL, "", ""); err == nil {
		t.Fatal("a non-extension origin must not be auto-paired")
	}
}

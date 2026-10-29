package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestDefaultCommandsPreserveCurrentBrowserAdapter(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "1")
	var received []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status" {
			writeCompactJSON(w, map[string]any{"extensionConnected": true})
			return
		}
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		mu.Lock()
		received = append(received, request["cmd"].(string))
		mu.Unlock()
		writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true, "tabs": []any{}, "nodes": []any{}, "snapshot": map[string]any{"nodes": []any{}}}})
	}))
	defer server.Close()
	for _, args := range [][]string{{"tabs"}, {"snapshot", "--semantic", "--diff"}, {"click", "12"}, {"open", "example.com"}, {"do", "click 12", "press Enter"}} {
		code, stdout, stderr := runJSONCLI(t, server.URL, args...)
		if code != 0 {
			t.Fatalf("%v: %d %s %s", args, code, stdout, stderr)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) < 6 {
		t.Fatalf("default commands did not use the existing-browser adapter: %v", received)
	}
}

func TestDefaultCommandOwnsBridgeAndClosesItOnExit(t *testing.T) {
	t.Setenv("BROWSERCONTROL_CLI_DEFAULT_ROUTE", "1")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	done := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(4 * time.Second)
		dialer := websocket.Dialer{HandshakeTimeout: 200 * time.Millisecond}
		for time.Now().Before(deadline) {
			conn, _, err := dialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d", port), nil)
			if err != nil {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			defer conn.Close()
			_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			err = conn.WriteJSON(map[string]any{"type": "hello", "role": "extension", "protocolVersion": 2, "token": "0123456789abcdef0123456789abcdef"})
			if err != nil {
				done <- err
				return
			}
			var ack map[string]any
			if err := conn.ReadJSON(&ack); err != nil {
				done <- err
				return
			}
			if ack["type"] != "hello_ack" {
				done <- fmt.Errorf("handshake rejected: %v", ack["type"])
				return
			}
			_, _, err = conn.ReadMessage()
			if err == nil {
				done <- fmt.Errorf("status dispatched browser input")
				return
			}
			done <- nil
			return
		}
		done <- fmt.Errorf("command bridge never listened")
	}()
	code, stdout, stderr := runCLIProcess(t, "status", "--port", strconv.Itoa(port), "--token", "0123456789abcdef0123456789abcdef", "--wait", "2s", "--json")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if code != 0 || singleJSONResult(t, stdout)["extensionConnected"] != true || stderr != "" {
		t.Fatalf("on-demand status: %d %s %s", code, stdout, stderr)
	}
	listener, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("bridge survived CLI exit: %v", err)
	}
	_ = listener.Close()
}

package cdp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func TestActionResultsHaveIdentityTimingAndNoImpliedVerification(t *testing.T) {
	_, target := inputTarget(t, func(ws *websocket.Conn) {
		for {
			var request inputRequest
			if ws.ReadJSON(&request) != nil {
				return
			}
			_ = ws.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}})
		}
	})
	seen := map[string]bool{}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, run := range []func() (driver.ActionResult, error){
		func() (driver.ActionResult, error) {
			return target.Click(context.Background(), driver.Point{X: 1, Y: 2})
		},
		func() (driver.ActionResult, error) { return target.InsertText(context.Background(), "fixture") },
		func() (driver.ActionResult, error) {
			return target.Press(context.Background(), []driver.Key{{Key: "Enter", Code: "Enter", VirtualKey: 13}})
		},
		func() (driver.ActionResult, error) { return target.Click(cancelled, driver.Point{X: 1, Y: 2}) },
		func() (driver.ActionResult, error) { return target.Press(context.Background(), nil) },
	} {
		result, _ := run()
		if err := result.Validate(); err != nil {
			t.Fatalf("invalid result: %+v %v", result, err)
		}
		if seen[result.ActionID] {
			t.Fatal("action ID reused")
		}
		seen[result.ActionID] = true
		if result.Verified || result.Observation != "not_observed" {
			t.Fatalf("input acknowledgement became verification: %+v", result)
		}
		data, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"actionId", "kind", "status", "dispatched", "inputState", "acknowledged", "startedAt", "dispatchedAt", "finishedAt", "bbox", "verified", "observation", "cleanupComplete"} {
			if _, ok := fields[key]; !ok {
				t.Fatalf("missing %s in %s", key, data)
			}
		}
		if !result.Dispatched && result.DispatchedAt != nil {
			t.Fatalf("timestamp invented before dispatch: %+v", result)
		}
	}
}

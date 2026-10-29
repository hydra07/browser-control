package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

func captureSample(t *testing.T) (captureDOM, []captureFrame, map[string][]captureAXNode) {
	t.Helper()
	var raw captureDOM
	err := json.Unmarshal([]byte(`{"strings":["","https://example.test/orders?orderId=ORD-42&token=url-secret","Orders","root","#document","INPUT","name","password","value","unique-secret-value","email","mai@example.test","script","#text","script-only-private-value","Mai Nguyen ORD-42","unused-string-secret","DIV","id","__bc_overlay","overlay-only-value"],"documents":[{"documentURL":1,"title":2,"frameId":3,"nodes":{"parentIndex":[-1,0,0,0,3,0,0,6],"nodeType":[9,1,1,1,3,3,1,3],"nodeName":[4,5,5,12,13,13,17,13],"nodeValue":[0,0,0,0,14,15,0,20],"backendNodeId":[1,2,3,4,5,6,7,8],"attributes":[[],[6,7,8,9],[6,10,8,11],[],[],[],[18,19],[]],"inputValue":{"index":[1,2],"value":[9,11]}}}]}`), &raw)
	if err != nil {
		t.Fatal(err)
	}
	frame := captureFrame{}
	frame.Frame.ID, frame.Frame.URL = "root", raw.Strings[1]
	var ax []captureAXNode
	if err := json.Unmarshal([]byte(`[{"nodeId":"root-ax","backendDOMNodeId":1,"role":{"value":"RootWebArea"},"name":{"value":"Orders"},"childIds":["secret","echo","overlay"]},{"nodeId":"secret","backendDOMNodeId":2,"role":{"value":"textbox"},"name":{"value":"Password"},"value":{"value":"unique-secret-value"},"properties":[{"name":"protected","value":{"value":true}}]},{"nodeId":"echo","backendDOMNodeId":6,"name":{"value":"Mai Nguyen ORD-42 unique-secret-value"}},{"nodeId":"overlay","backendDOMNodeId":7,"name":{"value":"overlay-only-value"}}]`), &ax); err != nil {
		t.Fatal(err)
	}
	return raw, []captureFrame{frame}, map[string][]captureAXNode{"root": ax}
}

func TestFixtureCaptureSanitizesBeforeLeavingAdapter(t *testing.T) {
	raw, frames, ax := captureSample(t)
	result, err := sanitizeCapture(raw, frames, ax, nil, driver.CaptureOptions{MaxNodes: 100, MaxFrames: 32}, "Chrome/test")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"unique-secret-value", "script-only-private-value", "unused-string-secret", "url-secret", "overlay-only-value"} {
		if strings.Contains(string(data), secret) {
			t.Errorf("capture retained forbidden value: %s", secret)
		}
	}
	for _, business := range []string{"Mai Nguyen", "ORD-42", "mai@example.test"} {
		if !strings.Contains(string(data), business) {
			t.Errorf("capture lost business value: %s", business)
		}
	}
	if findings := privacy.CheckFile("fixtures/synthetic/sample.json", data); len(findings) > 0 {
		t.Fatalf("sanitized capture failed privacy gate: %+v", findings)
	}
	if result.Truncated {
		t.Fatal("complete capture marked truncated")
	}
}

func TestFixtureRedactsCredentialsReflectedFromURL(t *testing.T) {
	raw, frames, ax := captureSample(t)
	raw.Strings[15] += " url-secret"
	result, err := sanitizeCapture(raw, frames, ax, nil, driver.CaptureOptions{MaxNodes: 100, MaxFrames: 32}, "Chrome/test")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "url-secret") || !strings.Contains(string(data), "Mai Nguyen") {
		t.Fatal("URL credential reflection was not scrubbed independently of business data")
	}
}

func TestFixtureCaptureRejectsMalformedTablesAndReportsBudgets(t *testing.T) {
	raw, frames, ax := captureSample(t)
	result, err := sanitizeCapture(raw, frames, ax, []string{"child"}, driver.CaptureOptions{MaxNodes: 3, MaxFrames: 1}, "Chrome/test")
	if err != nil || !result.Truncated || len(result.Documents[0].Nodes) != 3 || !reflect.DeepEqual(result.MissingFrames, []string{"child"}) {
		t.Fatalf("budget/coverage: %+v %v", result, err)
	}
	raw.Documents[0].Nodes.ParentIndex[1] = 1
	if _, err := sanitizeCapture(raw, frames, ax, nil, driver.CaptureOptions{MaxNodes: 100, MaxFrames: 32}, "Chrome/test"); err == nil {
		t.Fatal("accepted cyclic DOM parent")
	}
	raw, frames, ax = captureSample(t)
	raw.Documents[0].Nodes.InputValue.Value = nil
	if _, err := sanitizeCapture(raw, frames, ax, nil, driver.CaptureOptions{MaxNodes: 100, MaxFrames: 32}, "Chrome/test"); err == nil {
		t.Fatal("accepted malformed value table")
	}
}

func TestFixtureLeaseFailureCleansAnonymousContextWithoutReadingPage(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		for {
			var request struct {
				ID     uint64
				Method string
			}
			if ws.ReadJSON(&request) != nil {
				return
			}
			mu.Lock()
			methods = append(methods, request.Method)
			mu.Unlock()
			result := map[string]any{}
			switch request.Method {
			case "Target.createBrowserContext":
				result["browserContextId"] = "anonymous"
			case "Target.createTarget":
				result["targetId"] = "page"
			}
			if ws.WriteJSON(map[string]any{"id": request.ID, "result": result}) != nil {
				return
			}
		}
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	denied := errors.New("tab_owned")
	_, err = client.CaptureFixture(context.Background(), driver.CaptureRequest{URL: "https://example.test/"}, func(context.Context, string) error { return denied })
	if !errors.Is(err, denied) {
		t.Fatalf("claim error: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(methods, []string{"Target.createBrowserContext", "Target.createTarget", "Target.disposeBrowserContext"}) {
		t.Fatalf("page touched before lease: %v", methods)
	}
}

func TestFixtureReadinessWaitsForNewLoader(t *testing.T) {
	var mu sync.Mutex
	frames, earlyEvaluations := 0, 0
	endpoint := fakeChrome(t, func(ws *websocket.Conn) {
		for {
			var request struct {
				ID     uint64
				Method string
			}
			if ws.ReadJSON(&request) != nil {
				return
			}
			result := map[string]any{}
			mu.Lock()
			switch request.Method {
			case "Target.attachToTarget":
				result["sessionId"] = "capture"
			case methodFrameTree:
				frames++
				loader := "new"
				if frames == 1 {
					loader = "old"
				}
				result["frameTree"] = map[string]any{"frame": map[string]any{"id": "frame", "loaderId": loader}}
			case "Page.createIsolatedWorld":
				result["executionContextId"] = 1
			case "Runtime.evaluate":
				if frames < 2 {
					earlyEvaluations++
				}
				result["result"] = map[string]any{"type": "boolean", "value": true}
			}
			mu.Unlock()
			if ws.WriteJSON(map[string]any{"id": request.ID, "result": result}) != nil {
				return
			}
		}
	})
	client, err := Connect(context.Background(), endpoint, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	target, err := client.Attach(context.Background(), "page")
	if err != nil {
		t.Fatal(err)
	}
	if err := target.fixtureReady(context.Background(), false, "new"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if frames < 2 || earlyEvaluations != 0 {
		t.Fatalf("old document used for readiness: frames=%d early=%d", frames, earlyEvaluations)
	}
}

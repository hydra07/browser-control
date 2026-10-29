package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	extbridge "github.com/hydra07/browsercontrol/cli/internal/extension"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testSession(t *testing.T, handler http.HandlerFunc) *session {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &session{g: globalOpts{cfg: extbridge.Config{BaseURL: server.URL, Token: "0123456789abcdef0123456789abcdef", Timeout: time.Second}, noAutostart: true}, state: &cliState{}}
}

func TestCommandFailurePreservesResultAndStopsBatch(t *testing.T) {
	calls := 0
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeCompactJSON(w, map[string]any{"success": true, "result": map[string]any{"success": false, "reason": "assert_failed", "message": "missing text", "steps": []any{map[string]any{"success": false}}}})
	})
	_, err := cmdDo(s, cmdArgs{pos: []string{"exec fail_flow", "exec after_failure"}})
	var ce *cmdError
	if !errors.As(err, &ce) || ce.Result == nil || calls != 1 {
		t.Fatalf("must stop and preserve result: %v calls=%d", err, calls)
	}
}

func TestBatchHonorsEachStepsTimeoutWithoutEchoingInput(t *testing.T) {
	var timeouts []float64
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		timeouts = append(timeouts, body["timeoutMs"].(float64))
		writeCompactJSON(w, map[string]any{"success": true, "result": map[string]any{"success": true}})
	})
	out, err := cmdDo(s, cmdArgs{pos: []string{`type 42 "super-secret" --timeout 5ms`, `type 42 "Tiếng Việt 😀" --timeout 10ms`}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(timeouts, []float64{5, 10}) {
		t.Fatalf("timeouts=%v", timeouts)
	}
	data, _ := json.Marshal(out.data)
	if strings.Contains(out.text, "super-secret") || strings.Contains(string(data), "super-secret") {
		t.Fatal("batch echoed input")
	}
	words, _ := splitCommandLine(`type 42 "Tiếng Việt 😀"`)
	if words[2] != "Tiếng Việt 😀" {
		t.Fatalf("corrupted UTF-8: %q", words[2])
	}
}

func TestUnknownOutcomeIsNeverAutomaticallyReplayed(t *testing.T) {
	calls := 0
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close()
	})
	_, err := s.call("click", map[string]any{"nodeId": 42})
	if err == nil || !strings.Contains(err.Error(), "outcome unknown") || calls != 1 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestAmbiguousTargetFailsWithoutActing(t *testing.T) {
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		writeCompactJSON(w, map[string]any{"result": map[string]any{"count": 2, "matches": []any{map[string]any{"i": 42}}}})
	})
	payload := map[string]any{}
	if err := s.applyTarget(payload, "#duplicate", false); err == nil || payload["nodeId"] != nil {
		t.Fatalf("unsafe resolution: %v %v", payload, err)
	}
}

func TestRefScopeRejectsCrossTabAndPinsRememberedTab(t *testing.T) {
	s := &session{g: globalOpts{tabID: float64(8)}, state: &cliState{DocumentID: "doc", TabID: 7}}
	if err := s.applyTarget(map[string]any{}, "e1", false); err == nil {
		t.Fatal("cross-tab cache must be rejected")
	}
	s.g.tabID = nil
	p := map[string]any{}
	if err := s.applyTarget(p, "e1", false); err != nil || p["tabId"] != 7 {
		t.Fatalf("must pin cached tab: %v %v", p, err)
	}
}

func TestFlowEnvironmentBindingsAreExecutionOnly(t *testing.T) {
	t.Setenv("BC_TEST_INPUT", "secret-value")
	steps := []json.RawMessage{json.RawMessage(`{"action":"fill","selector":"#email","textFromEnv":"BC_TEST_INPUT"}`)}
	bound, err := bindFlowEnvironment(steps)
	if err != nil || !strings.Contains(string(bound[0]), "secret-value") || strings.Contains(string(bound[0]), "textFromEnv") {
		t.Fatalf("binding: %s %v", bound, err)
	}
	if strings.Contains(string(steps[0]), "secret-value") {
		t.Fatal("saved recipe was modified")
	}
	if _, err := bindFlowEnvironment([]json.RawMessage{json.RawMessage(`{"action":"fill","textFromEnv":"BC_UNSET_TEST"}`)}); err == nil {
		t.Fatal("missing variables must fail before execution")
	}
}

func TestParseCLISeparatesGlobalAndPayloadFlags(t *testing.T) {
	g, a, err := parseCLI([]string{"type", "12", "123", "--tab", "5", "--json", "--timeout", "5s", "--confirm-risky", "--max-chars", "300", "--text", "007"}, globalOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if !g.asJSON || g.tabID != float64(5) || g.cfg.Timeout != 5*time.Second || !g.timeoutSet {
		t.Fatalf("globals not parsed: %+v", g)
	}
	if !reflect.DeepEqual(a.pos, []string{"type", "12", "123"}) {
		t.Fatalf("positionals: %v", a.pos)
	}
	if a.flags["confirmRisky"] != true || a.flags["maxChars"] != float64(300) || a.flags["text"] != "007" {
		t.Fatalf("payload flags: %v", a.flags)
	}
}

func TestParseCLIKeepsNegativeNumbersAndDoubleDash(t *testing.T) {
	_, a, err := parseCLI([]string{"scroll", "-500", "--", "--not-a-flag"}, globalOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a.pos, []string{"scroll", "-500", "--not-a-flag"}) {
		t.Fatalf("positionals: %v", a.pos)
	}
}

func TestSplitCommandLine(t *testing.T) {
	got, err := splitCommandLine(`type 14 'hello world' "say \"hi\"" --snap`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"type", "14", "hello world", `say "hi"`, "--snap"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
	if _, err := splitCommandLine(`click 'oops`); err == nil {
		t.Fatal("unterminated quote should error")
	}
}

func TestApplyTargetWithoutBridge(t *testing.T) {
	s := &session{state: &cliState{DocumentID: "d4", TabID: 7}}
	p := map[string]any{}
	if err := s.applyTarget(p, "42", false); err != nil || p["nodeId"] != 42 {
		t.Fatalf("numeric target: %v %v", p, err)
	}
	p = map[string]any{}
	if err := s.applyTarget(p, "e12", false); err != nil || p["ref"] != "e12" || p["documentId"] != "d4" {
		t.Fatalf("ref target should pick up the remembered document id: %v %v", p, err)
	}
	s.state.DocumentID = ""
	if err := s.applyTarget(map[string]any{}, "e3", false); err == nil {
		t.Fatal("ref without any document id should be a usage error")
	}
}

func TestLooksLikeSelector(t *testing.T) {
	for _, v := range []string{"#id", ".cls", "a[href]", "input:focus", "//div", "form > input", "table", "form"} {
		if !looksLikeSelector(v) {
			t.Errorf("%q should be a selector", v)
		}
	}
	for _, v := range []string{"Sign in", "Login", "Delete account"} {
		if looksLikeSelector(v) {
			t.Errorf("%q should be text", v)
		}
	}
}

func TestXPathLiteral(t *testing.T) {
	if got := xpathLiteral(`it's "x"`); got != `concat("it's ", '"', "x", '"', "")` {
		t.Fatalf("got %s", got)
	}
	if xpathLiteral("plain") != `"plain"` {
		t.Fatal("plain literal")
	}
}

func TestFormatEntriesMergesGlyphRuns(t *testing.T) {
	nodes := []any{
		map[string]any{"i": float64(1), "r": "link", "n": "Home"},
		map[string]any{"i": float64(10), "r": "StaticText", "n": "H"},
		map[string]any{"i": float64(11), "r": "StaticText", "n": "i"},
		map[string]any{"i": float64(13), "r": "StaticText", "n": "yo"},
		map[string]any{"i": float64(20), "r": "button", "n": "Go", "v": "x"},
	}
	got := formatEntries(nodes)
	want := []string{`[1] link "Home"`, `[10] text "Hi yo"`, `[20] button "Go" (v: "x")`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestRenderDelta(t *testing.T) {
	delta := map[string]any{
		"scope":        map[string]any{"documentId": "d1"},
		"fromRevision": "r1", "toRevision": "r2",
		"added":   []any{map[string]any{"ref": "e9", "role": "button", "name": "Save"}},
		"changed": []any{map[string]any{"ref": "e2", "role": "textbox", "name": "Email", "value": "a@b"}},
		"removed": []any{"e7"},
	}
	got := snapshotDeltaView(delta, "", 0).text
	want := "doc d1 diff r1→r2\n+ e9 button \"Save\"\n~ e2 textbox \"Email\" = \"a@b\"\n- e7"
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestCLIHintRewritesMCPCalls(t *testing.T) {
	got := cliHint(`Call browser_session({action:"list_tabs"}) first.`)
	if got != "Call 'browsercontrol tabs' first." {
		t.Fatalf("got %q", got)
	}
}

func TestExtractBinaryWritesFileAndDropsBase64(t *testing.T) {
	dir := t.TempDir()
	png := []byte{0x89, 'P', 'N', 'G', 1, 2, 3}
	res := map[string]any{"format": "png", "dataBase64": base64.StdEncoding.EncodeToString(png)}
	path, err := extractBinary(res, dir, "shot", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := res["dataBase64"]; ok || res["dataPath"] != path || !strings.HasSuffix(path, ".png") {
		t.Fatalf("result not rewritten: %v", res)
	}
	if data, _ := os.ReadFile(path); string(data) != string(png) {
		t.Fatal("file content mismatch")
	}
}

func TestFilterLines(t *testing.T) {
	got := filterLines([]string{"[1] button \"Login\"", "[2] link \"Help\"", "[3] textbox \"login email\""}, "LOGIN", 1)
	if len(got.kept) != 1 || got.dropped != 2 {
		t.Fatalf("%+v", got)
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{
		"example.com":        "https://example.com",
		"localhost:3000/x":   "http://localhost:3000/x",
		"http://a.test":      "http://a.test",
		"about:blank":        "about:blank",
		"https://x.dev/path": "https://x.dev/path",
	}
	for in, want := range cases {
		if got := normalizeURL(in); got != want {
			t.Errorf("%s: got %s want %s", in, got, want)
		}
	}
}

func TestParseClip(t *testing.T) {
	clip, err := parseClip("10, 20,300x150")
	if err != nil {
		t.Fatal(err)
	}
	if clip["x"] != float64(10) || clip["height"] != float64(150) {
		t.Fatalf("%v", clip)
	}
	if _, err := parseClip("1,2,3"); err == nil {
		t.Fatal("three numbers should fail")
	}
}

func TestImageSize(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 37, 21))
	var pngBuf, jpgBuf bytes.Buffer
	_ = png.Encode(&pngBuf, img)
	_ = jpeg.Encode(&jpgBuf, img, nil)
	for name, data := range map[string][]byte{"png": pngBuf.Bytes(), "jpeg": jpgBuf.Bytes()} {
		if w, h, ok := imageSize(data); !ok || w != 37 || h != 21 {
			t.Errorf("%s: got %dx%d ok=%v", name, w, h, ok)
		}
	}
}

package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

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
	s := &session{state: &cliState{DocumentID: "d4"}}
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
	got := renderDelta(delta, "")
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

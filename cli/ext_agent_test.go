package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMalformedRepliesNeverReportSuccessfulActions(t *testing.T) {
	for _, reply := range []string{`{`, `{}`, `null`, `{"result":null}`, `{"result":{}}`, `{"result":[]}`, `{"result":"done"}`, `{"result":{"success":"false"}}`, `{"result":{"error":123}}`} {
		t.Run(reply, func(t *testing.T) {
			calls := 0
			s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				fmt.Fprint(w, reply)
			})
			_, err := cmdDo(s, cmdArgs{pos: []string{"click 42", "click 43"}})
			var ce *cmdError
			if !errors.As(err, &ce) || !strings.Contains(ce.Message, "outcome unknown") || !strings.Contains(ce.Hint, "no automatic replay") || calls != 1 {
				t.Fatalf("err=%v calls=%d", err, calls)
			}
		})
	}
}

func TestBridgeTimeoutAfterReconnectPreservesUnknownOutcome(t *testing.T) {
	for _, reconnect := range []bool{false, true} {
		t.Run(fmt.Sprint(reconnect), func(t *testing.T) {
			calls := 0
			s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/status" {
					writeCompactJSON(w, map[string]any{"extensionConnected": true})
					return
				}
				calls++
				if reconnect && calls == 1 {
					w.WriteHeader(http.StatusServiceUnavailable)
					fmt.Fprint(w, `{"error":"Extension not connected"}`)
					return
				}
				w.WriteHeader(http.StatusBadGateway)
				fmt.Fprint(w, `{"error":"command timed out"}`)
			})
			_, err := s.call("click", map[string]any{"nodeId": 42})
			var ce *cmdError
			expectedCalls := 1
			if reconnect {
				expectedCalls = 2
			}
			if !errors.As(err, &ce) || !strings.Contains(ce.Message, "outcome unknown") || ce.Hint == "" || calls != expectedCalls {
				t.Fatalf("err=%v calls=%d", err, calls)
			}
		})
	}
}

func TestInvalidFindResponsesNeverSelectTheFirstMatch(t *testing.T) {
	for _, result := range []map[string]any{
		{"matches": []any{map[string]any{"i": 42}}},
		{"count": 1, "matches": []any{map[string]any{"i": 42}, map[string]any{"i": 43}}},
		{"count": 0, "matches": []any{map[string]any{"i": 42}}},
		{"count": 1, "matches": []any{}},
		{"count": 1, "matches": []any{map[string]any{"i": 0}}},
		{"count": 1, "matches": []any{map[string]any{"i": 2.5}}},
	} {
		calls := 0
		s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
			calls++
			writeCompactJSON(w, map[string]any{"result": result})
		})
		if _, err := cmdClick(s, cmdArgs{pos: []string{"#target"}}); err == nil || calls != 1 {
			t.Fatalf("unsafe resolution: result=%v err=%v calls=%d", result, err, calls)
		}
	}
}

func TestBatchSyntaxMistakesAreRejectedBeforeActions(t *testing.T) {
	for _, badStep := range []string{`clik 43`, `click 'unterminated`, `click 43 --tab NaN`, `click 43 --confirm-risky=no`, `snapshot --limit`, `do "click 43"`} {
		calls := 0
		s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
			calls++
			writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true}})
		})
		_, err := cmdDo(s, cmdArgs{pos: []string{"click 42", badStep}})
		var ue *usageError
		if !errors.As(err, &ue) || calls != 0 {
			t.Fatalf("step=%q err=%v calls=%d", badStep, err, calls)
		}
	}
}

func TestBatchHelpDoesNotDispatchTheAction(t *testing.T) {
	calls := 0
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) { calls++ })
	out, err := cmdDo(s, cmdArgs{pos: []string{"click 42 --help"}})
	if err != nil || calls != 0 || !strings.Contains(out.text, "click <target>") {
		t.Fatalf("err=%v calls=%d text=%s", err, calls, out.text)
	}
}

func TestAgentInputMistakesAreUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"--target"}, {"--grep"}, {"--text"}, {"--limit", "-1"}, {"--limit", "1.5"},
		{"--limit", "NaN"}, {"--tab", "0"}, {"--tab", "1.5"}, {"--tab", "+Inf"},
		{"--timeout", "0"}, {"--timeout", "121s"}, {"--wait", "-1"}, {"--port", "0"},
		{"--force=off"}, {"--confirm-risky=no"}, {"--json=maybe"}, {"--snap=typo"},
	} {
		_, _, err := parseCLI(args, globalOpts{})
		var ue *usageError
		if !errors.As(err, &ue) {
			t.Fatalf("args=%v err=%v", args, err)
		}
	}
}

func TestExplicitFalseFlagsNeverEnableRiskOverrides(t *testing.T) {
	g, a, err := parseCLI([]string{"--confirm-risky=false", "--force=0", "--json=0", "--snap=false"}, globalOpts{})
	if err != nil || a.flags["confirmRisky"] != false || a.flags["force"] != false || g.asJSON || g.snap != "" {
		t.Fatalf("flags=%v global=%+v err=%v", a.flags, g, err)
	}
}

func TestSnapshotViewsBoundTextAndJSONWithoutHidingLateMatches(t *testing.T) {
	const count = 500
	plain, semantic := []any{}, []any{}
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("Control %03d", i)
		plain = append(plain, map[string]any{"i": i, "r": "button", "n": name})
		semantic = append(semantic, map[string]any{"ref": fmt.Sprintf("e%d", i), "role": "button", "name": name})
	}
	scope := map[string]any{"documentId": "doc", "tabId": 7}
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		result := map[string]any{"nodes": plain}
		if request["semantic"] == true {
			result = map[string]any{
				"snapshot": map[string]any{"nodes": semantic, "scope": scope, "revision": "r2"},
				"delta":    map[string]any{"added": semantic, "changed": []any{}, "removed": []any{}, "uncertainRefs": []any{"e500"}, "scope": scope, "fromRevision": "r1", "toRevision": "r2"},
			}
		} else if request["cmd"] == "query_region" {
			result = map[string]any{"tree": plain}
		}
		writeCompactJSON(w, map[string]any{"result": result})
	})
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	t.Setenv("BROWSERCONTROL_SESSION_ID", "snapshot-test")
	persistent, err := newSession(s.g)
	if err != nil {
		t.Fatal(err)
	}
	defer persistent.close()
	s.state = persistent.state
	for _, mode := range []string{"plain", "semantic", "diff", "region"} {
		t.Run(mode, func(t *testing.T) {
			base := func() map[string]any {
				flags := map[string]any{}
				if mode == "semantic" || mode == "diff" {
					flags["semantic"] = true
				}
				if mode == "diff" {
					flags["diff"] = true
				}
				if mode == "region" {
					flags["region"] = "#form"
				}
				return flags
			}
			bounded, err := cmdSnapshot(s, cmdArgs{flags: base()})
			if err != nil {
				t.Fatal(err)
			}
			view := asMap(bounded.data)
			if view["shown"] != defaultSnapshotLimit || view["total"] != count || view["viewFiltered"] != true || !strings.Contains(bounded.text, "80 of 500") {
				t.Fatalf("unbounded %s: %v", mode, view)
			}
			flags := base()
			flags["limit"] = float64(0)
			full, err := cmdSnapshot(s, cmdArgs{flags: flags})
			if err != nil {
				t.Fatal(err)
			}
			compactJSON, _ := json.Marshal(bounded.data)
			fullJSON, _ := json.Marshal(full.data)
			t.Logf("500 entries: text %d -> %d bytes; JSON %d -> %d bytes", len(full.text), len(bounded.text), len(fullJSON), len(compactJSON))
			if len(compactJSON) >= len(fullJSON)/4 || len(bounded.text) >= len(full.text)/4 {
				t.Fatal("output budget did not reduce the view")
			}
			flags = base()
			flags["grep"] = "Control 500"
			flags["limit"] = float64(1)
			late, err := cmdSnapshot(s, cmdArgs{flags: flags})
			if err != nil || asMap(late.data)["shown"] != 1 || !strings.Contains(late.text, "Control 500") {
				t.Fatalf("late match hidden: %v %s", err, late.text)
			}
		})
	}
	if s.state.DocumentID != "doc" || s.state.TabID != 7 {
		t.Fatal("filtered view lost ref scope")
	}
}

func TestFilteredDeltaDoesNotClaimThereWereNoChanges(t *testing.T) {
	delta := map[string]any{"added": []any{map[string]any{"ref": "e1", "name": "Save"}}, "changed": []any{}, "removed": []any{}}
	view := snapshotDeltaView(delta, "different", 1)
	if !strings.Contains(view.text, "no matching changes") || !strings.Contains(view.text, "0 of 1") || asMap(view.data)["viewFiltered"] != true {
		t.Fatalf("misleading delta: %s", view.text)
	}
}

func TestFlowOutputKeepsVerificationAndFailureVisibleWithoutVerboseMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flow.json")
	if err := os.WriteFile(path, []byte(`[{"action":"click","selector":"#target"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, success := range []bool{true, false} {
		result := map[string]any{"success": success, "verified": false, "runId": "run-1", "steps": []any{
			map[string]any{"index": 0, "action": "click", "success": true, "verified": false, "matched": map[string]any{"name": "private-target"}, "delta": map[string]any{"added": strings.Repeat("large page state", 500)}},
			map[string]any{"index": 1, "action": "assert_text", "success": success, "verified": success, "error": "assert_failed"},
		}}
		if !success {
			result["stoppedAtStep"] = 1
			result["message"] = "missing expected text"
		}
		s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
			var request map[string]any
			_ = json.NewDecoder(r.Body).Decode(&request)
			if request["cmd"] != "run_flow" {
				t.Errorf("flow run dispatched %v", request["cmd"])
			}
			writeCompactJSON(w, map[string]any{"result": result})
		})
		out, err := cmdFlow(s, cmdArgs{pos: []string{"run", path}})
		text := out.text
		if !success {
			var ce *cmdError
			if !errors.As(err, &ce) || ce.Result == nil || ce.Hint == "" {
				t.Fatalf("failure report lost: %v", err)
			}
			text = ce.Message
			if !strings.Contains(text, "stopped at step 2") {
				t.Fatal(text)
			}
		} else if err != nil || !strings.Contains(text, "2. assert_text: verified") {
			t.Fatalf("%v %s", err, text)
		}
		if strings.Contains(text, "private-target") || strings.Contains(text, "large page state") || !strings.Contains(text, "1. click: dispatched; outcome unverified") {
			t.Fatal(text)
		}
	}
}

func TestFlowStatusIsMetadataOnlyUnlessExplicitlyRequested(t *testing.T) {
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		writeCompactJSON(w, map[string]any{"result": map[string]any{"recording": true, "stepCount": 1, "steps": []any{map[string]any{"text": "secret recipe value"}}}})
	})
	for _, all := range []bool{false, true} {
		out, err := cmdFlow(s, cmdArgs{pos: []string{"status"}, flags: map[string]any{"all": all}})
		if err != nil || strings.Contains(out.text, "secret recipe value") != all {
			t.Fatalf("all=%v err=%v text=%s", all, err, out.text)
		}
	}
}

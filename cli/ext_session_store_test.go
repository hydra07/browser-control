package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestCLIRefScopeIsSessionScoped(t *testing.T) {
	root := t.TempDir()
	t.Setenv("BROWSERCONTROL_HOME", root)
	legacy := filepath.Join(root, "cli-state.json")
	legacyData := []byte(`{"documentId":"legacy-owner-unknown","tabId":99}`)
	if err := os.WriteFile(legacy, legacyData, 0o600); err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"agent-a", "agent-b"} {
		t.Setenv("BROWSERCONTROL_SESSION_ID", id)
		s, err := newSession(globalOpts{})
		if err != nil {
			t.Fatal(err)
		}
		if s.state.DocumentID != "" || s.state.TabID != 0 {
			t.Fatalf("%s inherited a different owner's target: %+v", id, s.state)
		}
		s.state.DocumentID, s.state.TabID = "doc-"+id, i+10
		if err := s.state.save(); err != nil {
			t.Fatal(err)
		}
		if err := s.close(); err != nil {
			t.Fatal(err)
		}
	}
	for i, id := range []string{"agent-a", "agent-b"} {
		t.Setenv("BROWSERCONTROL_SESSION_ID", id)
		s, err := newSession(globalOpts{})
		if err != nil {
			t.Fatal(err)
		}
		payload := map[string]any{}
		if err := s.applyTarget(payload, "e1", false); err != nil {
			t.Fatal(err)
		}
		if payload["documentId"] != "doc-"+id || payload["tabId"] != i+10 {
			t.Fatalf("%s resolved another session's ref: %+v", id, payload)
		}
		if err := s.close(); err != nil {
			t.Fatal(err)
		}
	}
	if data, err := os.ReadFile(legacy); err != nil || string(data) != string(legacyData) {
		t.Fatalf("legacy file changed: %s, %v", data, err)
	}
}

func TestCLIExplicitSessionOverridesEnvironment(t *testing.T) {
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	t.Setenv("BROWSERCONTROL_SESSION_ID", "env-session")
	g, args, err := parseCLI([]string{"snapshot", "--session-id", "flag-session"}, globalOpts{})
	if err != nil {
		t.Fatal(err)
	}
	s, err := newSession(g)
	if err != nil || s.sessionID != "flag-session" {
		t.Fatalf("flag must select disk and wire scope: %v, %v", s, err)
	}
	defer s.close()
	if _, exists := args.flags["sessionId"]; exists {
		t.Fatal("session selection leaked into per-command payload flags")
	}
	s.state.DocumentID, s.state.TabID = "flag-doc", 12
	if err := s.state.save(); err != nil {
		t.Fatal(err)
	}
	s, err = newSession(globalOpts{})
	if err != nil || s.state.DocumentID != "" {
		t.Fatalf("environment session inherited flag session: %v, %v", s, err)
	}
	defer s.close()
}

func TestCLISessionErrorsAreExplicit(t *testing.T) {
	root := t.TempDir()
	t.Setenv("BROWSERCONTROL_HOME", root)
	t.Setenv("BROWSERCONTROL_SESSION_ID", "../escape")
	if _, err := newSession(globalOpts{}); err == nil {
		t.Fatal("invalid environment session was accepted")
	}
	t.Setenv("BROWSERCONTROL_SESSION_ID", "agent")
	path := filepath.Join(root, "sessions", "agent", "session.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schemaVersion":900,"id":"agent"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newSession(globalOpts{}); err == nil {
		t.Fatal("future session state was silently discarded")
	}
}

func TestCLISelectedSessionReachesBrowser(t *testing.T) {
	t.Setenv("BROWSERCONTROL_HOME", t.TempDir())
	t.Setenv("BROWSERCONTROL_SESSION_ID", "env-session")
	var request map[string]any
	fixture := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true}})
	})
	g, _, err := parseCLI([]string{"--session-id", "flag-session"}, fixture.g)
	if err != nil {
		t.Fatal(err)
	}
	s, err := newSession(g)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if _, err := s.call("click", map[string]any{"ref": "e1", "documentId": "doc"}); err != nil {
		t.Fatal(err)
	}
	if request["sessionId"] != "flag-session" {
		t.Fatalf("wire session differs from disk session: %+v", request)
	}
}

func TestBatchCannotSwitchSessionAfterAnAction(t *testing.T) {
	calls := 0
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true}})
	})
	if _, err := cmdDo(s, cmdArgs{pos: []string{"click 12", "click 13 --session-id another"}}); err == nil {
		t.Fatal("batch accepted an inconsistent session")
	}
	if calls != 0 {
		t.Fatalf("batch sent %d commands before rejecting session change", calls)
	}
}

func TestRawPayloadCannotChangeSelectedSession(t *testing.T) {
	calls := 0
	s := testSession(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeCompactJSON(w, map[string]any{"result": map[string]any{"success": true}})
	})
	s.sessionID = "selected"
	if _, err := s.call("click", map[string]any{"sessionId": "different", "nodeId": 12}); err == nil || calls != 0 {
		t.Fatalf("raw payload changed wire scope: err=%v calls=%d", err, calls)
	}
	if _, err := s.call("click", map[string]any{"sessionId": "selected", "nodeId": 12}); err != nil || calls != 1 {
		t.Fatalf("matching explicit scope rejected: err=%v calls=%d", err, calls)
	}
}

func TestSavingRefScopePreservesSessionPermissions(t *testing.T) {
	root := t.TempDir()
	t.Setenv("BROWSERCONTROL_HOME", root)
	t.Setenv("BROWSERCONTROL_SESSION_ID", "policy-test")
	store, _ := sessionstore.NewStore(root, "policy-test")
	if err := store.Save(sessionstore.State{SchemaVersion: sessionstore.SchemaVersion, ID: "policy-test", Permissions: &sessionstore.Permissions{Read: true}}); err != nil {
		t.Fatal(err)
	}
	s, err := newSession(globalOpts{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	s.state.DocumentID, s.state.TabID = "new-document", 12
	if err := s.state.save(); err != nil {
		t.Fatal(err)
	}
	state, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if state.Permissions == nil || state.Permissions.Act || state.Permissions.Eval || !state.Permissions.Read {
		t.Fatalf("ref scope write reset security policy: %+v", state.Permissions)
	}
}

package session

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestSessionsKeepIndependentTargets(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"agent-a", "agent-b"} {
		store, err := NewStore(root, id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Load(); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("missing session: %v", err)
		}
		state := State{SchemaVersion: 1, ID: id, LastTarget: Target{DocumentID: "doc-" + id, TabID: len(id)}}
		if err := store.Save(state); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"agent-a", "agent-b"} {
		store, _ := NewStore(root, id)
		state, err := store.Load()
		if err != nil || state.ID != id || state.LastTarget.DocumentID != "doc-"+id {
			t.Fatalf("session %s: %+v, %v", id, state, err)
		}
		if _, err := os.Stat(filepath.Join(root, "sessions", id, "session.json")); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSessionIDsArePortableAndCannotEscapeRoot(t *testing.T) {
	for _, id := range []string{"", ".", "..", "../agent", `a\b`, "/absolute", "C:agent", "Agent", " agent", "a.b", "a ", "con", "nul", "aux", "prn", "com1", "lpt9", strings.Repeat("a", 65)} {
		t.Run(id, func(t *testing.T) {
			if _, err := NewStore(t.TempDir(), id); err == nil {
				t.Fatalf("accepted invalid session ID %q", id)
			}
		})
	}
	for _, id := range []string{"go-cli", "0", "agent_2", "com10", strings.Repeat("a", 64)} {
		if _, err := NewStore(t.TempDir(), id); err != nil {
			t.Fatalf("valid ID %q: %v", id, err)
		}
	}
}

func TestInvalidSessionFilesFailClosed(t *testing.T) {
	for name, data := range map[string]string{
		"malformed":       `{`,
		"future version":  `{"schemaVersion":2,"id":"agent"}`,
		"missing version": `{"id":"agent"}`,
		"wrong owner":     `{"schemaVersion":1,"id":"other"}`,
		"partial scope":   `{"schemaVersion":1,"id":"agent","lastTarget":{"documentId":"doc"}}`,
		"negative tab":    `{"schemaVersion":1,"id":"agent","lastTarget":{"documentId":"doc","tabId":-1}}`,
		"unknown field":   `{"schemaVersion":1,"id":"agent","secret":"ignored?"}`,
		"trailing value":  `{"schemaVersion":1,"id":"agent"} {}`,
		"oversized":       strings.Repeat(" ", 64*1024+1),
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "sessions", "agent", "session.json")
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			store, _ := NewStore(root, "agent")
			if _, err := store.Load(); err == nil || errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid state must be explicit: %v", err)
			}
		})
	}
}

func TestInvalidSavePreservesPreviousSession(t *testing.T) {
	root := t.TempDir()
	store, _ := NewStore(root, "agent")
	initial := State{SchemaVersion: 1, ID: "agent", LastTarget: Target{DocumentID: "old", TabID: 7}}
	if err := store.Save(initial); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []State{
		{SchemaVersion: 1, ID: "other"},
		{SchemaVersion: 2, ID: "agent"},
		{SchemaVersion: 1, ID: "agent", LastTarget: Target{TabID: 7}},
		{SchemaVersion: 1, ID: "agent", LastTarget: Target{DocumentID: strings.Repeat("x", 64*1024), TabID: 7}},
	} {
		if err := store.Save(invalid); err == nil {
			t.Fatalf("saved invalid state: %+v", invalid)
		}
		if got, err := store.Load(); err != nil || !reflect.DeepEqual(got, initial) {
			t.Fatalf("previous state changed: %+v, %v", got, err)
		}
	}
	updated := initial
	updated.LastTarget = Target{DocumentID: "new", TabID: 8}
	if err := store.Save(updated); err != nil {
		t.Fatal(err)
	}
	if got, err := store.Load(); err != nil || !reflect.DeepEqual(got, updated) {
		t.Fatalf("replacement: %+v, %v", got, err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "sessions", "agent"))
	if err != nil || len(entries) != 1 || entries[0].Name() != "session.json" {
		t.Fatalf("unexpected temporary files: %v, %v", entries, err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{
			filepath.Join(root, "sessions", "agent"):                 0o700,
			filepath.Join(root, "sessions", "agent", "session.json"): 0o600,
		} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("permissions %s: %v, %v", path, info, err)
			}
		}
	}
}

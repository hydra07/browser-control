package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSessionPermissionsDefaultEvalOff(t *testing.T) {
	permissions := DefaultPermissions()
	for _, capability := range []Capability{Read, Act} {
		if err := permissions.Check(capability, "https://example.test/orders"); err != nil {
			t.Fatal(err)
		}
	}
	if err := permissions.Check(Eval, "https://example.test"); err == nil {
		t.Fatal("arbitrary eval enabled by default")
	}
	permissions.Eval = true
	permissions.Origins = []string{"https://example.test"}
	if err := permissions.Check(Eval, "https://example.test:443/orders"); err != nil {
		t.Fatal(err)
	}
	for _, page := range []string{"https://example.test.evil.test/", "http://example.test/", "https://other.test/", "javascript:alert(1)"} {
		if err := permissions.Check(Act, page); err == nil {
			t.Fatalf("origin policy accepted %q", page)
		}
	}
	if err := (Permissions{}).Check(Read, "https://example.test/"); err == nil {
		t.Fatal("explicit deny-all became default allow")
	}
}

func TestOwnershipRequiresPIDStartAndExactProfile(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "profile")
	owned := OwnedProcess{PID: 123, Started: "start-1", Profile: profile}
	actual := ProcessIdentity{PID: 123, Started: "start-1", Arguments: []string{"chrome", "--user-data-dir=" + profile}}
	if err := owned.Validate(actual, profile); err != nil {
		t.Fatal(err)
	}
	for _, changed := range []ProcessIdentity{
		{PID: 124, Started: actual.Started, Arguments: actual.Arguments},
		{PID: actual.PID, Started: "reused-pid", Arguments: actual.Arguments},
		{PID: actual.PID, Started: actual.Started, Arguments: []string{"chrome", "--user-data-dir=" + profile + "-other"}},
		{PID: actual.PID, Started: actual.Started, Arguments: []string{"chrome", "--user-data-dir=" + profile, "--user-data-dir=/other"}},
	} {
		if err := owned.Validate(changed, profile); err == nil {
			t.Fatalf("unowned process accepted: %+v", changed)
		}
	}
	if err := owned.Validate(actual, profile+"-other"); err == nil {
		t.Fatal("metadata from another profile accepted")
	}
}

func TestNativeProcessStartIdentity(t *testing.T) {
	first, err := ProcessStart(os.Getpid())
	if err != nil || first == "" {
		t.Fatalf("start identity: %q %v", first, err)
	}
	second, err := ProcessStart(os.Getpid())
	if err != nil || second != first {
		t.Fatalf("unstable identity: %q %v", second, err)
	}
	if _, err := ProcessStart(-1); err == nil {
		t.Fatal("invalid PID accepted")
	}
}

func TestPermissionsPersistWithoutTurningExplicitDenyIntoDefaults(t *testing.T) {
	store, _ := NewStore(t.TempDir(), "agent")
	lock, err := store.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	state := State{SchemaVersion: SchemaVersion, ID: "agent", Permissions: &Permissions{}}
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := loaded.EffectivePermissions().Check(Read, "https://example.test"); err == nil {
		t.Fatal("explicit deny was replaced with defaults")
	}
	state.Permissions = nil
	if err := store.Save(state); err != nil {
		t.Fatal(err)
	}
	loaded, err = store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := loaded.EffectivePermissions().Check(Read, "https://example.test"); err != nil {
		t.Fatal("missing policy must use documented default", err)
	}
}

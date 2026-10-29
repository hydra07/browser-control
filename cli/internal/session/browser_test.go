package session

import (
	"context"
	"testing"
)

func TestBrowserLifecycleDoesNotInventProfilesOrOwnership(t *testing.T) {
	manager, err := NewBrowserManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := manager.Status(context.Background(), "agent")
	if err != nil || info.Running {
		t.Fatalf("missing profile: %+v %v", info, err)
	}
	if _, err := manager.Stop(context.Background(), "agent"); err == nil {
		t.Fatal("profile without ownership accepted for stop")
	}
	for _, profile := range []string{"../Chrome", "CON", "..", "a/b"} {
		if _, err := manager.Status(context.Background(), profile); err == nil {
			t.Fatalf("invalid profile accepted: %q", profile)
		}
	}
}

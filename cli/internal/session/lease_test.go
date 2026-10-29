package session

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestTabLeasePersistsAcrossCommandsAndExpires(t *testing.T) {
	root := t.TempDir()
	a, _ := NewStore(root, "agent-a")
	b, _ := NewStore(root, "agent-b")
	now := time.Now().UTC()
	a.now = func() time.Time { return now }
	b.now = a.now
	ctx := context.Background()
	first, err := a.ClaimTab(ctx, "browser-1", "TAB1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if first.Owner != "agent-a" {
		t.Fatalf("owner: %+v", first)
	}
	var owned *TabOwnedError
	if _, err := b.ClaimTab(ctx, "browser-1", "TAB1", time.Minute); !errors.As(err, &owned) || owned.Owner != "agent-a" {
		t.Fatalf("active lease stolen: %v", err)
	}
	if _, err := b.ClaimTab(ctx, "browser-2", "TAB1", time.Minute); err != nil {
		t.Fatal("same target ID in another browser must be independent", err)
	}
	now = now.Add(30 * time.Second)
	renewed, err := a.ClaimTab(ctx, "browser-1", "TAB1", time.Minute)
	if err != nil || !renewed.ExpiresAt.After(first.ExpiresAt) {
		t.Fatalf("renewal: %+v %v", renewed, err)
	}
	now = now.Add(61 * time.Second)
	reclaimed, err := b.ClaimTab(ctx, "browser-1", "TAB1", time.Minute)
	if err != nil || reclaimed.Owner != "agent-b" {
		t.Fatalf("expired lease not reclaimed: %+v %v", reclaimed, err)
	}
	if err := a.ReleaseTab(ctx, "browser-1", "TAB1"); !errors.As(err, &owned) {
		t.Fatalf("another session released an active lease: %v", err)
	}
	if err := b.ReleaseTab(ctx, "browser-1", "TAB1"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ClaimTab(ctx, "browser-1", "TAB1", time.Minute); err != nil {
		t.Fatal(err)
	}
}

func TestCorruptLeaseCannotBeSilentlyStolen(t *testing.T) {
	store, _ := NewStore(t.TempDir(), "agent")
	if _, err := store.ClaimTab(context.Background(), "browser", "target", time.Minute); err != nil {
		t.Fatal(err)
	}
	path, err := store.leasePath("browser", "target")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schemaVersion":999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimTab(context.Background(), "browser", "target", time.Minute); err == nil {
		t.Fatal("corrupt lease treated as unowned")
	}
	for _, ttl := range []time.Duration{0, -time.Second, 25 * time.Hour} {
		if _, err := store.ClaimTab(context.Background(), "browser", "target", ttl); err == nil {
			t.Fatal("invalid lease TTL accepted")
		}
	}
}

func TestConcurrentTabClaimsHaveOneOwner(t *testing.T) {
	root := t.TempDir()
	ready := make(chan struct{})
	results := make(chan error, 2)
	for _, id := range []string{"agent-a", "agent-b"} {
		go func() {
			store, _ := NewStore(root, id)
			<-ready
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := store.ClaimTab(ctx, "browser", "target", time.Minute)
			results <- err
		}()
	}
	close(ready)
	winners := 0
	for range 2 {
		err := <-results
		var owned *TabOwnedError
		if err == nil {
			winners++
		} else if !errors.As(err, &owned) {
			t.Fatal(err)
		}
	}
	if winners != 1 {
		t.Fatalf("%d concurrent owners", winners)
	}
}

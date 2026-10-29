package e2e

import (
	"errors"
	"strings"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/session"
)

func TestChromeDirectDriverLifecycle(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	if err := h.client.call(h.ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": p.session}, nil); err != nil {
		t.Fatal(err)
	}
	h.waitDetached(t, p.targetID)
	endpoint, err := cdp.Discover(h.profile)
	if err != nil || endpoint != h.endpoint {
		t.Fatalf("discover: %q, %v", endpoint, err)
	}
	client, err := cdp.Connect(h.ctx, endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	version, err := client.Version(h.ctx)
	if err != nil || version != h.version {
		t.Fatalf("version: %q, %v", version, err)
	}
	targets, err := client.Targets(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, target := range targets {
		if target.ID == p.targetID {
			found = true
		}
	}
	if !found {
		t.Fatal("driver did not discover fixture target")
	}
	target, err := client.Attach(h.ctx, p.targetID)
	if err != nil {
		t.Fatal(err)
	}
	world, err := target.IsolatedWorld(h.ctx, "browsercontrol-driver-test")
	if err != nil {
		t.Fatal(err)
	}
	value, err := world.Evaluate(h.ctx, `document.querySelector('button').textContent`)
	if err != nil || string(value) != `"Save fixture"` {
		t.Fatalf("DOM result: %s, %v", value, err)
	}
	_, err = world.Evaluate(h.ctx, `throw new Error('fixture evaluation failure')`)
	var evaluation *cdp.EvaluationError
	if !errors.As(err, &evaluation) {
		t.Fatalf("exception was not explicit: %v", err)
	}
	for method := range client.Stats().Calls {
		if strings.HasSuffix(method, ".enable") {
			t.Fatalf("driver enabled an unsolicited domain: %s", method)
		}
	}
	_ = client.Close()
	if _, err := world.Evaluate(h.ctx, `true`); !errors.Is(err, cdp.ErrDetached) {
		t.Fatalf("closed handle reused: %v", err)
	}
	h.waitDetached(t, p.targetID)
}

func TestChromeOwnershipMatchesRealProcessAndProfile(t *testing.T) {
	h := startChrome(t)
	client, err := cdp.Connect(h.ctx, h.endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	actual, err := client.BrowserIdentity(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	started, err := session.ProcessStart(h.pid)
	if err != nil {
		t.Fatal(err)
	}
	owned := session.OwnedProcess{PID: h.pid, Started: started, Profile: h.profile}
	identity := session.ProcessIdentity{PID: actual.PID, Started: started, Arguments: actual.Arguments}
	if err := owned.Validate(identity, h.profile); err != nil {
		t.Fatalf("owned Chrome identity rejected: %v", err)
	}
	owned.Started = "previous-browser-instance"
	if err := owned.Validate(identity, h.profile); err == nil {
		t.Fatal("stale process identity authorized shutdown")
	}
}

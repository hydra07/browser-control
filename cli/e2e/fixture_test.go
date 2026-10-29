package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

func TestChromeCollectsTenSyntheticFixtures(t *testing.T) {
	h := startChrome(t)
	client, err := cdp.Connect(h.ctx, h.endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := devtools.StartFixtureServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	baseline := fixtureContexts(t, h)
	for _, name := range devtools.FixtureNames() {
		t.Run(name, func(t *testing.T) {
			uri, err := server.URL(name)
			if err != nil {
				t.Fatal(err)
			}
			claims := 0
			claimed := ""
			capture, err := client.CaptureFixture(h.ctx, driver.CaptureRequest{URL: uri, CaptureOptions: driver.CaptureOptions{RequireFixtureReady: true}}, func(_ context.Context, id string) error { claims++; claimed = id; return nil })
			if err != nil {
				t.Fatal(err)
			}
			if claims != 1 || capture.Truncated || len(capture.Frames) == 0 || len(capture.Documents) == 0 || len(capture.Accessibility) == 0 || len(capture.Accessibility[0].Nodes) == 0 {
				t.Fatalf("incomplete fixture: claims=%d frames=%d dom=%d ax=%d truncated=%t missing=%v", claims, len(capture.Frames), len(capture.Documents), len(capture.Accessibility), capture.Truncated, capture.MissingFrames)
			}
			if name == "nested-frames" && (len(capture.Frames) != 3 || len(capture.Documents) != 3 || len(capture.Accessibility) != 3) {
				t.Fatal("nested frame coverage missing")
			}
			if name == "modal" {
				modal := false
				for _, node := range capture.Accessibility[0].Nodes {
					modal = modal || node.Role == "dialog" && node.States["modal"] == "true"
				}
				if !modal {
					t.Fatal("fixture did not expose a real modal dialog")
				}
			}
			fixture := devtools.NormalizeSynthetic(devtools.Fixture{SchemaVersion: 1, Classification: devtools.Synthetic, SourceURL: "fixture:" + name, Observation: "snapshot_at", Snapshot: capture}, server.BaseURL)
			data, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			if findings := privacy.CheckFile("fixtures/synthetic/captures/"+name+".json", data); len(findings) != 0 {
				t.Fatalf("privacy: %+v", findings)
			}
			if name == "react-admin" && !strings.Contains(string(data), "Mai Nguyen") {
				t.Fatal("React component did not mount")
			}
			if name == "shadow-dom" && (!strings.Contains(string(data), "Advanced settings") || !strings.Contains(string(data), "Save settings")) {
				t.Fatal("open/closed shadow controls absent")
			}
			out := filepath.Join(t.TempDir(), name+".json")
			if os.Getenv("BROWSERCONTROL_FIXTURE_CREATE") == "1" {
				out = filepath.Join("fixtures", "synthetic", "captures", name+".json")
			}
			root, err := devtools.Worktree(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			plan, err := devtools.PrepareOutput(h.ctx, root, out, devtools.Synthetic)
			if err != nil {
				t.Fatal(err)
			}
			if err := plan.Write(fixture); err != nil {
				t.Fatal(err)
			}
			after, err := client.Targets(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, target := range after {
				if target.ID == claimed {
					t.Fatal("anonymous page was not disposed")
				}
			}
			if !reflect.DeepEqual(fixtureContexts(t, h), baseline) {
				t.Fatal("anonymous browser context leaked")
			}
			t.Logf("frames=%d documents=%d AX trees=%d captureBytes=%d", len(capture.Frames), len(capture.Documents), len(capture.Accessibility), len(data))
		})
	}
	for method := range client.Stats().Calls {
		if strings.HasSuffix(method, ".enable") || strings.HasPrefix(method, "Input.") || strings.HasPrefix(method, "Storage.") || strings.HasPrefix(method, "Network.") || strings.Contains(method, "Screenshot") {
			t.Fatalf("unsolicited capture domain: %s", method)
		}
	}
}

func fixtureContexts(t *testing.T, h *chromeHarness) []string {
	t.Helper()
	var result struct{ BrowserContextIDs []string }
	if err := h.client.call(h.ctx, "", "Target.getBrowserContexts", nil, &result); err != nil {
		t.Fatal(err)
	}
	slices.Sort(result.BrowserContextIDs)
	return result.BrowserContextIDs
}

func TestChromePrivateFixtureRedactsSecretsAndPublicContextHasNoProfileCredentials(t *testing.T) {
	h := startChrome(t)
	client, err := cdp.Connect(h.ctx, h.endpoint, cdp.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><html><title>Private form</title><label>Name <input value="Mai Nguyen"></label><label>Email <input name="email" value="mai@example.test"></label><label>Password <input id="password" type="password"></label><label>OTP <input id="otp" autocomplete="one-time-code"></label><p id="echo"></p><p id="auth"></p><script>document.getElementById('auth').textContent=document.cookie.includes('signed_in=yes')?'Profile credentials present':'Anonymous visitor';</script></html>`))
	}))
	defer server.Close()
	page, err := client.NewPage(h.ctx, server.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	var world *cdp.World
	for {
		world, err = page.IsolatedWorld(h.ctx, "fixture-setup")
		if err == nil {
			ready, evalErr := world.Evaluate(h.ctx, `document.readyState === 'complete' && !!document.getElementById('password')`)
			if evalErr == nil && string(ready) == "true" {
				break
			}
		}
		select {
		case <-h.ctx.Done():
			t.Fatal("form not ready")
		case <-time.After(25 * time.Millisecond):
		}
	}
	if _, err := world.Evaluate(h.ctx, `document.cookie='signed_in=yes; SameSite=Lax'; document.getElementById('auth').textContent='Profile credentials present'; document.getElementById('password').value='private-fixture-secret'; document.getElementById('otp').value='824193'; document.getElementById('echo').textContent='Echo private-fixture-secret and 824193'; true`); err != nil {
		t.Fatal(err)
	}
	id := page.ID()
	if err := page.Close(h.ctx); err != nil {
		t.Fatal(err)
	}
	claim := func(context.Context, string) error { return nil }
	private, err := client.CaptureFixture(h.ctx, driver.CaptureRequest{URL: server.URL + "/", TargetID: id, Private: true}, claim)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(private)
	for _, secret := range []string{"private-fixture-secret", "824193", "signed_in=yes"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("private fixture leaked secret %q", secret)
		}
	}
	if !strings.Contains(string(data), "mai@example.test") || !strings.Contains(string(data), "Profile credentials present") {
		t.Fatal("private fixture lost business/authenticated content")
	}
	if findings := privacy.CheckFile("fixtures/public/test.json", data); len(findings) != 0 {
		t.Fatalf("private scrubber failed gate: %+v", findings)
	}
	public, err := client.CaptureFixture(h.ctx, driver.CaptureRequest{URL: server.URL + "/"}, claim)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(public)
	if !strings.Contains(string(data), "Anonymous visitor") || strings.Contains(string(data), "Profile credentials present") {
		t.Fatal("public collection reused profile credentials")
	}
	pages, err := client.Targets(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, existing := range pages {
		found = found || existing.ID == id && existing.URL == server.URL+"/"
	}
	if !found {
		t.Fatal("private capture closed/navigated the existing page")
	}
	limited, err := client.CaptureFixture(h.ctx, driver.CaptureRequest{URL: server.URL + "/", CaptureOptions: driver.CaptureOptions{MaxNodes: 3}}, claim)
	if err != nil || !limited.Truncated || len(limited.Documents[0].Nodes) != 3 {
		t.Fatalf("budget not reported: %v %t", err, limited.Truncated)
	}
}

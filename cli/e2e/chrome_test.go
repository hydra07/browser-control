package e2e

import (
	"encoding/json"
	"testing"
)

func TestChromeDOMAXAndInput(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	var tree struct {
		Nodes []struct {
			BackendID int                    `json:"backendDOMNodeId"`
			Role      struct{ Value string } `json:"role"`
			Name      struct{ Value string } `json:"name"`
		}
	}
	p.call(t, "Accessibility.getFullAXTree", nil, &tree)
	var saveID int
	for _, node := range tree.Nodes {
		if node.Role.Value == "button" && node.Name.Value == "Save fixture" {
			if saveID != 0 {
				t.Fatal("fixture has more than one Save button")
			}
			saveID = node.BackendID
		}
	}
	if saveID == 0 {
		t.Fatal("Chrome AX tree did not expose the fixture's Save button")
	}

	p.eval(t, `document.querySelector("input").focus(), true`, nil)
	p.call(t, "Input.insertText", map[string]any{"text": "Ada Fixture"}, nil)
	p.click(t, saveID)
	p.wait(t, `document.querySelector('[role="status"]').textContent === "Saved Ada Fixture"`)

	var value string
	p.eval(t, `document.querySelector("input").value`, &value)
	if value != "Ada Fixture" {
		t.Fatalf("insertText produced %q", value)
	}
	var overlays int
	p.eval(t, `document.querySelectorAll('[id^="__bc_"]').length`, &overlays)
	if overlays != 0 {
		t.Fatalf("direct CDP fixture unexpectedly contains %d BrowserControl overlays", overlays)
	}
}

func TestChromeNavigationInvalidatesExecutionContext(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	world := p.isolatedWorld(t)
	p.evalIn(t, world, `globalThis.__bcE2EProbe = "before-navigation"`, nil)
	p.navigate(t, "/controls.html?navigation=next")
	if err := p.request("Runtime.evaluate", map[string]any{
		"expression": "globalThis.__bcE2EProbe", "contextId": world, "returnByValue": true,
	}, nil); err == nil {
		t.Fatal("the old execution context remained usable after document navigation")
	}
	var missing bool
	p.evalIn(t, p.isolatedWorld(t), `globalThis.__bcE2EProbe === undefined`, &missing)
	if !missing {
		t.Fatal("the old document's sentinel leaked into the new document")
	}
}

func TestChromeRuntimeExceptionIsExplicit(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	if _, err := p.evaluate(0, `(() => { throw new Error("synthetic fixture error"); })()`); err == nil {
		t.Fatal("Runtime exception was treated as a successful evaluation")
	}
}

func TestChromeIsolatedWorldReconnectProbe(t *testing.T) {
	h := startChrome(t)
	p := h.open(t, "/controls.html")
	world := p.isolatedWorld(t)
	p.eval(t, `globalThis.__bcE2EMain = "same-document"`, nil)
	p.evalIn(t, world, `(() => {
		const node = document.querySelector("button");
		globalThis.__bcE2EProbe = { refs: new WeakMap([[node, "e1"]]) };
		return true;
	})()`, nil)
	targetID := p.targetID
	h.reconnect(t)
	h.waitDetached(t, targetID)
	p = h.attach(t, targetID)
	var sameDocument bool
	p.eval(t, `globalThis.__bcE2EMain === "same-document"`, &sameDocument)
	if !sameDocument {
		t.Fatal("reconnecting unexpectedly replaced the document")
	}
	var survived bool
	p.evalIn(t, p.isolatedWorld(t), `globalThis.__bcE2EProbe?.refs.get(document.querySelector("button")) === "e1"`, &survived)
	report, err := json.Marshal(map[string]any{
		"spike": "R0-S1", "chrome": h.version, "sameDocument": sameDocument,
		"isolatedWorldRediscovered": survived, "weakMapIdentitySurvived": survived,
		"scope": "headless temporary agent profile; no production page core or user-profile consent",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(report))
}

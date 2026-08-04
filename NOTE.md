# Known issues / follow-ups

Tracked here instead of GitHub Issues because `gh` isn't authenticated in
this environment (`gh auth status` → not logged in). Once `gh auth login`
is run, each section below is ready to become `gh issue create --title ... --body ...`
verbatim — they're written as standalone issue bodies, not session notes.

---

## Bugs

### 1. `browser_navigate` hangs for the full 15s daemon timeout on `data:` URLs

**Found:** manually testing `browser_run_flow`'s risky-action block (needed a
disposable test page).

**Repro:**
```json
{"cmd":"navigate","url":"data:text/html,<button>Delete Account</button>"}
```
via `/execute` — times out at exactly 15000ms with a generic `{"error":"Timeout", ...}`,
no other diagnostic.

**Suspected cause:** `handleNavigate` (`src/extension/background.ts:1113`)
waits for `chrome.tabs.onUpdated`'s `status === 'complete'` event before
resolving. `data:` URL navigations may never fire that event the same way a
real HTTP(S) load does (or fire it before the listener attaches), so the
promise never resolves and the daemon's outer timeout is the only thing that
eventually surfaces it.

**Impact:** low for normal use (nobody navigates real flows to `data:`
URLs), but worth fixing since (a) it's a silent full-timeout hang with zero
useful error, and (b) `data:` URLs are a convenient way to build disposable
test pages for future work on this repo itself (as it was needed here).

**Not fixed** — worked around by injecting a test element into a real page
via `browser_evaluate` instead of navigating to a `data:` URL.

---

## Test debt (implemented, never exercised end-to-end)

### 2. `run_flow`/`explore_flow`'s `wait_for` and `assert_text` actions are untested

`src/extension/background.ts` — `wait_for` handling around line 753,
`assert_text` around line 823 (see the `runFlowSteps` switch). Every other
action (`click`, `type`, `press_key`, `scroll`) was verified live this
session (successful run, not-found stop, risky-block, `confirmRisky`
override, 8-step timing). `wait_for` (poll-until-appears with a timeout) and
`assert_text` (substring check against a resolved element's accessible
name) were written to match the plan but never actually run against a live
page.

**To verify:** a flow step like `{"action":"wait_for","role":"...","name":"...","timeoutMs":3000}`
against an element that appears asynchronously (e.g. after a click
triggers a fetch), and `{"action":"assert_text","role":"...","name":"...","contains":"..."}`
both for a passing and a failing case.

### 3. Ambiguous role+name matches (`ambiguous: true`) never actually observed

`resolveStepTarget` sets `ambiguous: true` when more than one AX node
matches the same role+name, mirroring `replay.ts`'s existing
`resolveNodeIdByIdentity` leniency (first match wins, just flagged). Never
triggered against a real page with genuinely duplicate role+name elements
this session — worth a deliberate test (e.g. a page with two buttons both
named "Edit").

---

## Known limitation (not a bug, but worth documenting/fixing)

### 4. The accessibility tree only covers the main frame — iframe-embedded UI is invisible

**Found:** trying to test `browser_run_flow`'s risky-action block against
Google's real "Sign out" link. `browser_snapshot`/`browser_explore_flow`
after opening the Google account menu showed no trace of "Sign out" at all
— Google's account chooser widget renders in an iframe
(`accounts.google.com`), and `Accessibility.getFullAXTree` (used
everywhere: `snapshot`, `query_region`, `visual_snapshot`, and now
`resolveStepTarget` for flow steps) only walks the top frame's tree by
default.

**Impact:** any UI embedded via iframe — OAuth/account widgets, Stripe/
payment checkout embeds, some chat widgets, ad-tech consent dialogs — is
completely invisible to every browsercontrol tool, not just flows. This
predates `run_flow`/`explore_flow` (the same main-frame-only limitation
applies to plain `browser_snapshot`) but only got noticed now because a
flow script's `resolveStepTarget` failure ("not_found") was the first time
it actually blocked a concrete test.

**Possible fix:** CDP's `Accessibility.getFullAXTree` and `DOM.getDocument`
both accept a `depth`/frame-scoping story via `Page.getFrameTree` +
per-frame AX tree calls (`Accessibility.getAXNodeByFrameId` or attaching a
target session per subframe) — nontrivial, needs its own design pass on
how to merge/flatten a multi-frame AX tree into the existing flat
`{i,r,n,v}` snapshot shape without breaking `backendDOMNodeId`-based
click/type (a backendNodeId is only meaningful within its own frame's
document, not globally).

---

## Deferred by design (already noted in the approved plan for `run_flow`/`explore_flow`, restated here so they don't get lost)

### 5. `sessionFlow.ts` doesn't yet suggest `browser_run_flow`

The existing flow-warning system (`src/server/lib/sessionFlow.ts`) flags
patterns like repeated clicks on the same node or `browser_evaluate` used to
simulate interaction. It could add: "you've made N manual click/type calls
in the last M commands with no `browser_run_flow`/`browser_explore_flow` —
consider batching the next known sequence" — nudging the token-saving
workflow the same way it already nudges away from other bad patterns.

### 6. Risky-keyword list is hardcoded

`RISKY_NAME_PATTERN` in `src/extension/background.ts` (line 482) is a
fixed regex (`delete|remove|uninstall|deactivate|cancel|unsubscribe|sign
out|log out|pay|purchase|confirm|permanently`). No way to extend or narrow
it per project/site without editing source. Could become an optional
`riskyPatterns` array param on `browser_run_flow`/`browser_explore_flow`.

### 7. Flow scripting is a flat step list — no conditionals/loops/data extraction

Explicit v1 scope decision: no `if`/`loop`, and no data-extraction action
beyond `assert_text`'s substring check. If a flat list turns out
insufficient for real usage (e.g. "click each row's delete button" needs a
loop over a dynamic list), the next step would be a small real DSL
(server-side JS eval in a constrained context) — a materially bigger and
riskier build than the current flat list, intentionally not attempted yet.

---

## Older, previously-deprioritized item (carried over, still unresolved)

### 8. `replay.ts` identity-resolution race with a custom combobox in a consumer project

In `mio-fe-admin` (a separate repo), the INQ004 form's custom combobox
component appears to interact badly with `resolveNodeIdByIdentity`'s extra
snapshot round-trip during replay — suspected popup-lifecycle timing issue
(the combobox's dropdown may close/reopen or re-render between the replay
tool's snapshot call and the subsequent click). Not investigated further;
the user explicitly deprioritized this earlier ("để bạn tìm cách fix tiếp").
Not urgent since it only affects `replay.ts` (a dev/debugging tool), not
live `browser_click`/`browser_type`/`browser_run_flow` usage.

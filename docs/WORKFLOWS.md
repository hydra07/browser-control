# Legacy extension workflows (Flow v2)

This document describes the explicit extension adapter. The default vNext CLI uses direct CDP; see README.md for its current commands. The legacy runtime is the Go CLI plus the Chrome extension. A workflow is a bounded, sequential JSON script, not an arbitrary program or an exactly-once transaction.

The extension compatibility path requires an explicit foreground `browsercontrol extension serve` in another
terminal. Commands never auto-start a bridge, including when the legacy `--no-autostart=false` is used.

## Authoring contract

Use schemaVersion 2, at most 20 steps per call, explicit tab selection and an explicit entry URL. Supported actions are `click`, `type`, `fill`, `press_key`, `wait_for`, `assert_text`, `scroll`, and `drag`. `type` inserts at the caret; `fill` selects and replaces the entire value. Recorded input events use `fill`.

Targets can use a unique CSS `selector`, an exact accessible `name` plus optional `role`, or `target` with `id`, `testId` (`data-testid`), `inputName`, `inputType`, `href`, and `selectorHints`. Role/name constraints remain mandatory when supplied alongside a selector. Ambiguous targets stop; they never select the first match. Descriptor `ancestors` and `nearby` are not implemented and are rejected, not silently ignored.

`policy.onDrift` defaults to stopping semantic repairs. Use `repair` explicitly when a reviewed name variation is acceptable. `report` may continue after a failed business assertion, but the final report still has `success:false`. A risky click or Enter requires `confirmRisky:true` only after the agent has confirmed intent with its user. The name-based risk guard is a heuristic, not a sandbox or authorization system. Arbitrary `eval` can bypass it.

Postconditions use `expected`:

- `text`: body text contains `contains`.
- `navigation`: URL changed and optionally matches a `urlPattern` glob.
- `state`: `selector` exists, an `attribute` exists/equals `value`, or `property` (`value`, `checked`, `disabled`) equals the string `value`.

Checks poll within the step timeout and request deadline. DOM quiet is only a settling signal; it does not prove a business outcome. Omit `expected` only when dispatch-level success is sufficient.

## Example: verified draft save

This recipe assumes a reviewed page has these exact controls; derive the locators from a live snapshot/inspection, not from guesses.

```json
{
  "schemaVersion": 2,
  "name": "Save draft",
  "domain": "example.test",
  "steps": [
    {
      "action": "fill",
      "target": { "testId": "draft-title", "role": "textbox", "name": "Title" },
      "textFromEnv": "BC_DRAFT_TITLE",
      "policy": { "timeoutMs": 5000, "onDrift": "stop" }
    },
    {
      "action": "click",
      "target": { "testId": "save-draft", "role": "button", "name": "Save draft" },
      "expected": { "kind": "text", "contains": "Draft saved" },
      "policy": { "timeoutMs": 5000, "onDrift": "stop" }
    }
  ]
}
```

Set `BC_DRAFT_TITLE` in the caller's environment; do not put sensitive values in shell arguments, recorded recipes or source control. The CLI resolves `textFromEnv` just for execution and does not modify the saved recipe. Raw extension requests must supply already-resolved `text`. Empty environment values are allowed; missing variables stop before execution.

```text
browsercontrol extension open https://example.test/drafts/new --new-tab
browsercontrol extension snapshot --tab <returned-id> --semantic
browsercontrol extension flow validate draft.json --tab <returned-id> --json
browsercontrol extension flow run draft.json --tab <returned-id> --timeout 30s --json
```

`flow validate` needs a paired extension and validates structure only. It does not dispatch page actions, check current DOM availability, or confirm a real backend outcome. Domain is an assertion, not an instruction to navigate to the domain root. Navigate to the entry URL explicitly.

## Read the result before retrying

Successful workflow reports include `runId`, per-step `actionId`, and `verified`. `success:true, verified:false` means at least one step was dispatched without a business postcondition. `verified:true` means the declared checks passed; their quality still depends on what the author asserted.

`--json` writes one object per invocation. A failed `do` includes completed `steps` (when any), `failedStep: {step, command}`, and the failing command's payload in `result` when available, alongside `error`/`hint`. The CLI stops at that step. Do not concatenate multiple JSON objects or replay completed steps. Usage errors retain exit code 2 even inside a batch.

In-band `success:false` becomes CLI exit 1; `--json` keeps the failure result and completed steps. Timeout/disconnect is an unknown outcome. The bridge requests cancellation, the queue discards expired work, and workflows stop before the next step. A dispatched click, input, network request or page script cannot necessarily be undone or interrupted. Do not restart a purchase, submit or delete simply because the client timed out. Inspect the page and actual backend state first. Retry automatically only when it is known that nothing was dispatched.

If an action completed but `--snap` failed, the result explicitly says that snapshot capture failed; it does not misreport the action as unexecuted. Batch `do` output includes step number and command name, not the original line containing input values. CLI requests use `go-cli` by default. Use `BROWSERCONTROL_SESSION_ID` or the same explicit `--session-id` for actions and queries when tracking a named session; the flag takes precedence. Select a session on the entire `do` batch, not individual steps.

The remembered semantic document/tab is isolated in `~/.browsercontrol/sessions/<id>/session.json` (`BROWSERCONTROL_HOME` overrides the root). The former global `cli-state.json` is not imported because its owner is unknown; take a fresh semantic snapshot after upgrading. This disk scope is separate from extension evidence: the current evidence store retains only the active session, and switching sessions resets that timeline. Tab leases and concurrent multi-agent evidence isolation remain pending.

Browser commands are currently globally serialized because active-tab/evidence state is shared. This favors safe ordering over cross-tab throughput; it is not a reservation across multiple CLI invocations. Pin `--tab`, avoid concurrent workflows sharing a tab, and do not assume tab grouping is an access-control boundary.

## Capture and scope

Video chunks stream to a bounded file in the bridge's `~/.browsercontrol/artifacts`, rather than returning base64 in agent output. `capture stop [out.webm]` returns the path; a local `out` is copied atomically without buffering the whole recording. Limits are 10 minutes and 256 MiB per capture, plus bounded frame/transport queues. A remote bridge path belongs to that host. Empty or failed recordings do not report a successful save. Record the explicit `--tab` you intend to inspect.

Network/HAR records are tab-scoped and metadata-first; body access remains explicit. HTTP mutation mocking intercepts POST/PUT/PATCH/DELETE only. GET/HEAD, WebSocket messages and other channels still reach servers; mocked success is not real backend verification.

## Remaining architecture work

These are not provided by the current changes:

- Durable run journal/checkpoints and explicit resume with verified preconditions; `runId` is correlation, not a persistent deduplication guarantee.
- Full per-tab leases and multi-agent isolation; the global queue is only an in-worker ordering guard.
- Version-negotiated capabilities/JSON Schema generation, offline validation parity, broader locator context/iframe handling and additional actions such as native select/check/upload.
- Artifact retention/quota across recordings, evidence persistence coalescing and profiler-backed performance budgets.
- Real-Chrome E2E coverage after each extension reload. Unit tests and fake-extension HTTP/WS tests do not prove actual browser behavior.

A "perfect" script is not guaranteed on a changing external website. The practical target is: explicit inputs and locators, validated steps, verified outcomes, bounded work, visible partial progress, and no blind replay of uncertain side effects.

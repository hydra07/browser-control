# Action and resume ground truth — R0-02

These synthetic fixtures are inputs for the later identity, projection, checkpoint and resume tests.
They are collected from owned temporary Chrome profiles using the R0-01 sanitizer. Expected refs and
content values are declared in `cli/e2e/sequence_cases_test.go`, independently of the current semantic
engine. Passing the corpus checks does not implement or validate the future production resume engine.

The [R0-03 identity regression suite](../IDENTITY_REGRESSIONS.md) feeds these captures through the
current collector and semantic engine, with explicit expected failures and a strict reproduction mode.

| Kind | Scenario | Expected result |
| --- | --- | --- |
| Action | `action-form-save` | Native input followed by Save; physical ref survives both updates |
| Action | `action-modal` | Open a real modal, then save and close it; background node identity survives |
| Action | `action-insert-reorder` | Insert a sibling and reorder two identically named row buttons without swapping refs |
| Action | `action-replacement` | Identical replacement invalidates the old ref; clicking the fresh node changes status |
| Action | `action-virtualized` | Recycle the same row/button nodes for different orders, then return to the first window |
| Resume | `resume-warm` | No CDP connection during mutation; scoped observer retains intermediate states; `continuous` |
| Resume | `resume-gap` | Observer disconnected before mutation; same document/WeakMap survives; `reconstructed` |
| Resume | `resume-reload` | Actual reload; new document namespace; unique target remaps; `reconstructed` |
| Resume | `resume-navigate` | Actual URL/document change; absent old target is stale; `reconstructed` |
| Resume | `resume-browser-restart` | Stop/start the same owned profile, explicitly reopen the URL; new browser/document; `reconstructed` |
| Resume | `resume-table-gap` | While disconnected: edit ORD-42, remove ORD-43, insert ORD-44; keyed net diff |
| Resume | `resume-missing-scope` | Checkpoint lacks the requested field; `incomplete` and `not_observed` |

Each action sequence has three states and two native input steps, with a witnessed ref for every input
target before dispatch. Previously observed nodes may retain cached physical identity while hidden;
that does not make them actionable. Each resume sequence has before/after
states. The embedded page in `cli/internal/devtools/pages/sequence.html` is test infrastructure, served
only on loopback. It has a document UUID, a WeakMap for physical node witnesses, and a small independent
MutationObserver with a 32-entry status history. It is not the production page core or Timeline.

Idle updates wait on a test HTTP barrier. The runner closes/detaches every command connection before
releasing that barrier, then waits for an HTTP completion signal before reconnecting. No timing-only
sleep is used to infer that mutation occurred while disconnected. The Go test process remains alive.
Restart uses the owned browser manager and checks that the browser/process identity changed.

## Schema version 1

`kind` is `action` or `resume`. `states` contain the sanitized DOM/AX/frame snapshot and explicit oracle
metadata; `transitions` contain the trigger and expected results. All states have
`observation: "snapshot_at"`. DOM and AX are sequential observations; neither the observer nor these fixtures proves
atomic collection, production settle behavior, a backend effect or a successful future resume command.

- `document` is the fixture page's UUID, not a CDP context ID. It namespaces every `ref` in that state.
  `snapshot.epoch` identifies the separate capture observation. `browser-1`/`browser-2` are test labels
  assigned only after checking the owned browser lifecycle; they are not reconnectable endpoints.
- `nodes` join declared fixture refs to independently observed WeakMap `physical` identities and DOM
  `handle` witnesses. `key` is a unique `data-testid` in this single-frame test page. These are offline
  oracle labels and join IDs; never feed them back to Chrome as persisted execution handles.
- `anchor` is the nearest captured `data-test` ancestor, such as an order ID. `anchorGuard` describes
  that business anchor only. It does not assert visibility, interactability or every final-guard check.
  A recycled button keeps physical identity but fails the old order's anchor check. An identical new
  DOM node gets a fresh ref even if its text/attributes match the removed node.
- Mapping decisions are `retained` within a document, `remapped` to a uniquely witnessed matching
  target in a new document, or `stale` with no destination. Ref numbers may repeat in different
  documents; their document namespace must never be discarded. Reordering cannot exchange identities.
- `facts` describe checkpoint coverage separately from the full diagnostic snapshot. `captured:false`
  has no value, even if the full DOM snapshot contains that field. A captured null value means known
  absence in the declared coverage; an empty string means an observed empty field.
- Expected content is exhaustive for declared facts: `changed`, `added`, `removed`, `unchanged` or
  `not_observed`. Diffs need captured values on both sides. Virtualized rows outside the rendered
  window are `not_observed`, not removed; `aria-rowcount` remains a separate total hint.
- `coverage` records scope, gap, observer state, revision/history bounds and unobservable classes.
  `continuous` is limited to observed DOM mutations in that scope. Programmatic form values and
  offscreen virtualized rows are explicitly unobservable. A gap requires reconstruction; missing task
  scope requires incomplete provenance. Reconstructed content describes only the net before/after diff.

The reader rejects unsupported schema fields, privacy/size failures, source-ref reuse for a different
physical node, cross-document retention, fabricated anchors/content, incomplete mapping coverage and
provenance inconsistent with observation coverage. It does not call the production semantic engine.
An ordinary E2E-package test also checks the versioned refs, facts, transitions and coverage against
the declarative cases, so changing a scenario without reviewing its recorded contract fails CI.

## Verify and reproduce

From `cli/`, ordinary `go test ./internal/devtools` validates the versioned corpus without launching a
browser. With an explicit Chrome executable, collect fresh candidates into test-owned temporary files:

```powershell
$env:BROWSERCONTROL_E2E_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
go test -race -count=1 -v ./e2e -run '^TestChromeActionAndResumeSequences$'
```

The initial corpus is created with `BROWSERCONTROL_SEQUENCE_CREATE=1`; creation refuses to overwrite
existing files. Do not leave that variable enabled for ordinary tests. To add a new case, declare its
states and expectations first, then run only that case with the creation flag. For reviewed refreshes,
set `BROWSERCONTROL_SEQUENCE_OUTPUT=data/fixtures/<fresh-review-directory>` to write fresh candidates
under the worktree root, compare their contracts and replace only the reviewed JSON. This override
takes precedence over the creation flag; it also refuses existing destinations. Clear both variables
for ordinary verification and keep unrelated fixture/worktree changes intact.

Generated origins normalize to `http://fixture.test`. Browser IDs, node IDs, document UUIDs and observer
batching may vary across Chrome runs; assertions use their relations and declared content rather than
a byte-for-byte comparison. React/static R0-01 capture inputs remain in the sibling `captures/` directory.

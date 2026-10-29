# Direct agent commands

The canonical build is `cd cli && go build -o browsercontrol.exe .`. Call that executable directly;
the default agent commands do not require `serve`, an extension or the old `cdp` namespace.

```powershell
.\cli\browsercontrol.exe open https://example.com
.\cli\browsercontrol.exe snapshot --limit 80
.\cli\browsercontrol.exe click <observed-id> --snap
.\cli\browsercontrol.exe fill <observed-field-id> 'new value' --snap
.\cli\browsercontrol.exe read
.\cli\browsercontrol.exe wait 'visible confirmation' --timeout 10s
.\cli\browsercontrol.exe screenshot data/screenshots/result.png
.\cli\browsercontrol.exe tabs
```

`open` starts/reuses a dedicated, persistent agent profile and selects its page. To start headless,
use `open <url> --headless --executable <Chrome path>` or `browser start` before `open`.
Existing-user-Chrome attachment is still gated; an arbitrary browser on port 9222 is never selected.
Use `--session-id` consistently. Different agents sharing a profile should use separate sessions and
`open <url> --new-tab`; durable tab leases reject another session's live tab ownership.

Every command opens a fresh bounded CDP connection, verifies browser PID/start/profile ownership,
and closes its socket/target session on exit. There is no BrowserControl daemon or local page index.
The owned Chrome process and its login state remain until `browser stop`.

## Observe, act, verify

Snapshot returns a compact text view by default, with 80 nodes; `--limit 0` removes the view cap and
`--grep` filters before limiting. JSON contains structured nodes under `snapshot.nodes`, the observed
document ID, coverage, shown/total counts and collection truncation. `read --max-chars 6000` returns
visible body text, and `wait 'text'` polls for visible page text. Use `wait 'css=#notice'` for a visible
CSS match. Read-only commands do not append mutation intent records.

Node IDs are physical-node identities held in a named isolated world, using a WeakMap and bounded
WeakRef lookup map. That renderer state survives command socket closure on the locally tested Chrome.
Session disk state stores only the selected target, document stamp and tab index mapping: no CDP
session/execution-context/remote-object handles, typed text, DOM projections or node pointers.

`click 1` means an ID from the last observed document, not the first node of a newly collected list.
Reorder preserves physical IDs. A removed/replaced node, changed control witness, different tab or
new document rejects an old ID. Take another snapshot to observe changes. A CSS target searches the
main document and must resolve to exactly one visible enabled element; use snapshot IDs for open
shadow controls. Clicks also check occlusion. Fields must be editable/focused.
These checks are a basic direct compatibility layer, not the completed vNext identity/barrier protocol.

`fill` replaces a field value; `type` inserts text, with `--clear` to replace. `press Control+a`,
`press Enter`, `press Tab` and named navigation keys use paired input dispatch/cleanup. `scroll down`,
`scroll up` or `scroll <dy> [dx]` scroll the selected page. CDP acknowledgement does not prove a UI
effect: action results keep `verified:false`. Verify with an independent snapshot/read/wait.

`tabs` lists target IDs and indexes. `--tab <target-id>` selects an exact page; numeric tab indexes
refer to the last saved tab list rather than a newly reordered list. `tabs switch <id|index>` selects
the session's page without focusing the user's browser window. `tabs new <url>` creates a tab and
`tabs close <id|index>` closes only that owned profile's selected target. Closing another target
preserves the session's current page.

Screenshot saves PNG bytes to a local file and prints path/size, never base64. Default output is under
`data/screenshots/`; explicit `.png` destinations are exclusive, so existing files are not overwritten.
`--full` requests bounded full-page capture. Screenshots are explicit captures and may contain page
content; keep private captures local according to [the artifact policy](PRIVACY.md).

## Uncertain actions

Mutations hold the session lock/tab lease, fsync intent before dispatch, and append an outcome.
Typed payloads and URLs are not stored in the action journal. Transport loss/deadline after dispatch
can produce `outcome_unknown`; it is never retried automatically. Further mutation is blocked while
an intent/outcome is uncertain, but read/snapshot/tab listing remain available.

```powershell
browsercontrol pending
browsercontrol snapshot
browsercontrol read
# Only after inspecting the outcome and choosing to accept that uncertainty:
browsercontrol ack <action-id> --ack-unknown
```

Acknowledgement is an append-only record, not a fabricated successful outcome or UI verification.
It preserves the original unknown record, survives restart, and permits later decisions. It never
replays the original action. The full automatic `verify`/resume/recovery protocol remains future work.

## Scope and validation

Collection is bounded to 20,000 scanned elements, 2,000 returned nodes and 256 open roots. The ref
lookup retains only the latest collection; its WeakMap does not keep removed elements alive. Names
and values are clipped/normalized for compact output, and collection truncation is explicit. Main
document/open shadow roots are supported; child frames, closed shadow roots, full AX/WebTree IR,
advanced query grammar, checkpoints and direct Flow execution are not implemented by this layer.

Password/credential-like field values and recognized secret patterns are redacted in text/JSON;
this is not completion of the broader runtime privacy/fault matrix. Session read/act/origin policies
are checked, including a page-origin guard immediately before input. Arbitrary eval stays disabled.

Native Windows acceptance launches a standalone CLI executable for each command against an owned
headless Chrome profile and synthetic form. It covers the agent loop, WeakMap continuity, reorder,
DOM replacement/navigation rejection, empty fill, Shift input, open-shadow controls, selector ambiguity,
output limits, screenshots/no overwrite,
tab management, read-only policy, durable unknown-action gating/ack and zero bridge HTTP requests.
To test the actual installed repo binary, set `BROWSERCONTROL_E2E_CLI_BINARY` to its absolute path:

```powershell
cd cli
go build -o browsercontrol.exe .
$env:BROWSERCONTROL_E2E_CHROME = '<installed Chrome executable>'
$env:BROWSERCONTROL_E2E_CLI_BINARY = (Resolve-Path browsercontrol.exe).Path
go test -count=1 -run '^TestDirectAgentNativeCLI$' -v .
```

Ordinary tests skip browser launch unless Chrome is explicitly configured. This local acceptance
does not establish hosted Linux/macOS results, all-site/model success, or full vNext completion.

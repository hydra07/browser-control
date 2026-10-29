# Legacy extension adapter (track X)

These instructions apply only to the explicit `extension` namespace. The default vNext CLI uses direct CDP; the bridge is not part of its setup. This existing adapter is retained during migration, without marking the S3/S6 fallback gate complete.

# BrowserControl

A token-cheap CLI for AI agents to drive **your real, logged-in Chrome** through the BrowserControl extension.

```text
agent / shell ──▶ browsercontrol extension <cmd>          (short-lived process, prints compact text)
                     │ HTTP + bearer token
                     ▼
                  bridge  127.0.0.1:8765         (explicit foreground `browsercontrol extension serve`)
                     │ WebSocket
                     ▼
                  Chrome extension (MV3) ──CDP──▶ real tabs
```

No MCP server and no Bun daemon: one Go binary plus the extension.

For verified scripts, inputs, recovery rules and current limits, see [Reliable agent workflows](docs/WORKFLOWS.md).
Measured output sizes and verified/unverified control coverage are in [Control readiness](docs/CONTROL_READINESS.md).

## Setup (once)

```bash
cd cli && go build -o browsercontrol.exe .     # or ./browsercontrol extension on macOS/Linux
cd app/extension && bun install && bun run build   # load app/extension/.output/chrome-mv3 unpacked
```

1. Load the extension in `chrome://extensions` (Developer mode → Load unpacked).
2. Run `browsercontrol extension token`. In `chrome://extensions`, open BrowserControl's service worker console
   and set the local pairing token as shown below. Treat the token as a secret.
3. In a separate terminal, run `browsercontrol extension serve` and keep it open.
4. Run `browsercontrol extension status --wait 20s`; it exits 0 once the extension authenticates.

```js
const key = "browsercontrol_settings";
const stored = await chrome.storage.local.get(key);
await chrome.storage.local.set({
  [key]: { ...stored[key], daemonAuthToken: "PASTE_BROWSERCONTROL_TOKEN_HERE" },
});
```

Close the console after pairing. Existing stored pairing tokens are retained. The extension has no
Side Panel; browser actions and saved flows use the CLI. Direct-CDP profile lifecycle is being built
in the default CLI; the extension remains the current compatibility control path.

Token disclosure based only on an extension Origin header is disabled by default: native clients can forge that header.
For trusted local development only, `BROWSERCONTROL_AUTO_PAIR=1` opts back into the old origin-pinning handshake,
and only on a loopback-bound bridge. This opt-in is convenience, not an authentication boundary.
If pairing is refused, `status` prints the reason (log: `~/.browsercontrol/bridge.log`).

The token comes from `data/daemon-auth-token` (found by walking up from the cwd **or** from the binary),
then `~/.browsercontrol/daemon-auth-token`, or `--token` / `--token-file` / `BROWSERCONTROL_AUTH_TOKEN`.
Commands never start a bridge process. The extension compatibility path needs an explicit
`browsercontrol extension serve` in a foreground terminal; diagnostics go to that terminal's stderr.
`--wait` (20s) waits for the extension to reconnect to an already running bridge.
The legacy `--no-autostart` flag is accepted as a no-op; `=false` cannot enable background startup.

## Agent loop

Run `browsercontrol extension help agent` for a short, offline guide suitable for agents with small context windows.
Pin `--tab <id>`, observe with `snapshot --semantic --grep <word>`, act on a fresh ref, then
verify the expected text/selector with `wait`. An action's `ok` confirms dispatch; business results need verification.

```bash
browsercontrol extension open example.com
browsercontrol extension snapshot                 # [810] link "Learn more"   ← one line per node
browsercontrol extension click 810 --snap         # act, then print the fresh snapshot in the same call
browsercontrol extension do "type Search 'golang cdp'" "press Enter" "wait Results" "snapshot --grep result"
```

Output is plain text designed for agents: no pretty-printed JSON, no base64, no MCP-style boilerplate.
Errors go to stderr as `error: ...` + `hint: ...` with exit code 1 (2 = usage error). `--json` switches every
command to a single-line JSON object (`{"error","hint"}` on failure). Partial batch failures include
completed `steps`, a `failedStep` with step number/command, and the failing command's `result` when available.
No completed steps means `steps` is omitted. Help uses `{"help":"…"}`; `serve` sends diagnostics to stderr
and emits its JSON result when it exits. JSON scripts upgrading from earlier versions should read
`eval` values from `result`, `flow list` from `flows`, `search` from `results`, and `crawl` from `pages`.

### Cheapest ways to look

| Need | Command | Notes |
|---|---|---|
| Find one control | `snapshot --grep login` | filters lines client-side |
| Page overview, interactive | `snapshot` | defaults to 80 entries; text runs are merged; `--limit 0` shows all |
| One container | `snapshot --region "form"` | indented subtree |
| What changed | `snapshot --semantic --diff` | `+ added`, `~ changed`, `- removed` since the last semantic snapshot |
| Text search | `find "Sign in"` | ids + surrounding context |
| Article text | `read --max-chars 6000` | |
| Element as markdown | `select "article .body"` | |
| Pixels | `screenshot` / `visual` | saved to `~/.browsercontrol/artifacts`; only the path + pixel size is printed |
| One element / area | `screenshot --target "#chart"`, `--clip 0,0,600,300 --zoom 2` | small areas auto-zoom (≤3x) |
| Whole page | `screenshot --full` | also stitches app-style inner scroll containers (chat, mail, docs) |

Snapshot `--grep` and `--limit` apply to plain, semantic, diff and region output, including `--json`.
Filtering searches the full collected view before the cap. Omitted entries are reported; semantic JSON retains
scope/revision and adds `shown`, `total`, `viewFiltered`. A filtered view is partial: missing nodes are not deletions.
Use compact text by default; raw `exec`, `eval`, full bodies and `--limit 0` can still produce large outputs.
`flow run`/`explore` prints a short line per step with its verification state; `--json` retains the full report.
`flow status` returns recording metadata; add `--all` to request steps. `flow stop` prints a summary;
use `--json` to inspect/export its recorded recipe.

Screenshots are CSS-pixel sized on any display, so 2x/3x screens don't inflate the image. BrowserControl's own
highlight/cursor overlays are hidden during the capture. A background tab is activated just for the capture, and
the user's previous tab is restored afterwards.

### Targets

`click`, `type`, `press`, `inspect` accept:

- `810` — node id from `snapshot` / `find` / `visual` (cheapest, no extra round trip)
- `e12` — semantic ref; the document id of the last `snapshot --semantic` is remembered automatically
- `#submit`, `.btn`, `a[href]`, `//xpath` — resolved through `find`
- `Sign in` — visible text / placeholder / aria-label, resolved through `find` (`text:` / `css:` prefixes force a mode)

Semantic ref scope is stored per session in `~/.browsercontrol/sessions/<id>/session.json`.
Choose a separate `--session-id agent-a` for each agent, or set `BROWSERCONTROL_SESSION_ID`;
the flag takes precedence and the default is `go-cli`. IDs use 1–64 lowercase ASCII letters,
digits, `_` or `-`, start with a letter or digit, and exclude Windows device names.
`BROWSERCONTROL_HOME` overrides the state directory. Use the same session for observation and action;
for `do`, select it on the whole batch. Session scope does not reserve a browser tab.
Raw `exec` payloads cannot override the selected session; choose it with the global flag.
The old global `cli-state.json` is left untouched and is not imported: take a fresh
`snapshot --semantic --tab <id>` when upgrading. Corrupt or unsupported session files stop the command.

Risky targets (delete, pay, submit…) are refused until you confirm with the user and add `--confirm-risky`.
`click` hovers first, clicks the visible part of the element, and refuses when something else (cookie banner,
modal) sits on top of it (`--force` overrides). `fill` / `type --clear` replace a field's value. `press` takes
combos (`Control+a`, `Shift+Tab`), and `scroll --in <target>` scrolls an inner container. If a page is still
animating after an action, the action is reported as ok with a warning, not as an error, so agents don't
repeat clicks.

### Commands

```text
open <url> [--new-tab] [--background]   back | forward | reload
snapshot [--grep s] [--limit n] [--region css] [--semantic] [--diff]
find <text|css|xpath>   read   select <css>   peek   inspect <target>
screenshot [file] [--full] [--format png]   visual [file]
click <target>   type <target> <text>   press <key> [target]
scroll [dy|dx dy|up|down]   drag x1 y1 x2 y2   eval <js|@file.js>
wait <text|css|xpath> [--gone] [--timeout 15s]   wait 2s
do "<cmd>" "<cmd>" ...   do - < steps.txt           (one process, stops at the first failure)
tabs [list [--all]|switch <id>|close <id>|new <url>]  (any command: --tab <id>)
net [list [filter]|detail <id> [--body]|clear|har [--out f]]
dev layout|memory|process|emulate|sandbox|har
flow run|explore|validate <file|id> | record | stop [--save id] | status | list | show | save <id> <file> | rm
search <query>   crawl <url...|@urls.txt>   capture start|stop   evidence
status [--wait 20s]   serve   token   exec <raw_cmd> [key=value|--k v|@payload.json]
cdp <command>      direct CDP via rod, bypasses the extension (debug only)
```

`browsercontrol extension help <command>` prints details for one command. `browsercontrol extension extension <cmd>` / `ext <cmd>`
still work as aliases for older scripts.

Saved flows live in `~/.browsercontrol/flows/<id>.json` and are managed with the CLI.

### Flow recording

Use `browsercontrol extension flow record <domain> --tab <id>` to start recording page actions, then
`browsercontrol extension flow stop --save <name>` to save them. Inspect with `flow list`/`flow show <name>`
and run with `flow run <name> --tab <id>`. Check the result before retrying a failed execution;
commands are never automatically replayed after an uncertain response.

After rebuilding the extension, reload BrowserControl in `chrome://extensions` to apply changes.

### PowerShell wrapper

```powershell
function bc { & "C:\path\to\browsercontrol.exe" @args }
```

## Development

See [AGENTS.md](AGENTS.md).

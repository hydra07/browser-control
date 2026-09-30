# BrowserControl

A token-cheap CLI for AI agents to drive **your real, logged-in Chrome** through the BrowserControl extension.

```text
agent / shell ──▶ browsercontrol <cmd>          (short-lived process, prints compact text)
                     │ HTTP + bearer token
                     ▼
                  bridge  127.0.0.1:8765         (auto-started, detached; `browsercontrol serve`)
                     │ WebSocket
                     ▼
                  Chrome extension (MV3) ──CDP──▶ real tabs
```

No MCP server and no Bun daemon: one Go binary plus the extension.

## Setup (once)

```bash
cd cli && go build -o browsercontrol.exe .     # or ./browsercontrol on macOS/Linux
cd app/extension && bun install && bun run build   # load app/extension/.output/chrome-mv3 unpacked
```

1. Load the extension in `chrome://extensions` (Developer mode → Load unpacked).
2. Run `browsercontrol status --wait 20s`. It starts the bridge, and the extension pairs itself on connect;
   the command exits 0 once it's connected.

Auto-pairing: an extension with no token (or a stale one) is handed the token in the handshake if it comes from
the trusted `chrome-extension://<id>` origin. The first extension that pairs is pinned in
`~/.browsercontrol/trusted-extension-id` (override with `BROWSERCONTROL_EXTENSION_ID`). Delete that file to trust a
different install. Pasting `browsercontrol token` into side panel → Settings still works. If pairing is refused,
`status` prints the bridge's reason (log: `~/.browsercontrol/bridge.log`).

The token comes from `data/daemon-auth-token` (found by walking up from the cwd **or** from the binary),
then `~/.browsercontrol/daemon-auth-token`, or `--token` / `--token-file` / `BROWSERCONTROL_AUTH_TOKEN`.
Any command starts the bridge in the background when it isn't running (log: `~/.browsercontrol/bridge.log`),
and waits up to `--wait` (20s) for the extension to reconnect. Use `--no-autostart` to turn that off.

## Agent loop

```bash
browsercontrol open example.com
browsercontrol snapshot                 # [810] link "Learn more"   ← one line per node
browsercontrol click 810 --snap         # act, then print the fresh snapshot in the same call
browsercontrol do "type Search 'golang cdp'" "press Enter" "wait Results" "snapshot --grep result"
```

Output is plain text designed for agents: no pretty-printed JSON, no base64, no MCP-style boilerplate.
Errors go to stderr as `error: ...` + `hint: ...` with exit code 1 (2 = usage error). `--json` switches every
command to single-line JSON (`{"error","hint"}` on failure).

### Cheapest ways to look

| Need | Command | Notes |
|---|---|---|
| Find one control | `snapshot --grep login` | filters lines client-side |
| Whole page, interactive | `snapshot` | runs of per-glyph `StaticText` are merged into one `text` line |
| One container | `snapshot --region "form"` | indented subtree |
| What changed | `snapshot --semantic --diff` | `+ added`, `~ changed`, `- removed` since the last semantic snapshot |
| Text search | `find "Sign in"` | ids + surrounding context |
| Article text | `read --max-chars 6000` | |
| Element as markdown | `select "article .body"` | |
| Pixels | `screenshot` / `visual` | saved to `~/.browsercontrol/artifacts`; only the path + pixel size is printed |
| One element / area | `screenshot --target "#chart"`, `--clip 0,0,600,300 --zoom 2` | small areas auto-zoom (≤3x) |
| Whole page | `screenshot --full` | also stitches app-style inner scroll containers (chat, mail, docs) |

Screenshots are CSS-pixel sized on any display, so 2x/3x screens don't inflate the image. BrowserControl's own
highlight/cursor overlays are hidden during the capture. A background tab is activated just for the capture, and
the user's previous tab is restored afterwards.

### Targets

`click`, `type`, `press`, `inspect` accept:

- `810` — node id from `snapshot` / `find` / `visual` (cheapest, no extra round trip)
- `e12` — semantic ref; the document id of the last `snapshot --semantic` is remembered automatically
- `#submit`, `.btn`, `a[href]`, `//xpath` — resolved through `find`
- `Sign in` — visible text / placeholder / aria-label, resolved through `find` (`text:` / `css:` prefixes force a mode)

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
flow run|explore <file|id> | record | stop [--save id] | status | list | show | save <id> <file> | rm
search <query>   crawl <url...|@urls.txt>   capture start|stop   evidence
status [--wait 20s]   serve   token   exec <raw_cmd> [key=value|--k v|@payload.json]
cdp <command>      direct CDP via rod, bypasses the extension (debug only)
```

`browsercontrol help <command>` prints details for one command. `browsercontrol extension <cmd>` / `ext <cmd>`
still work as aliases for older scripts.

Saved flows live in `~/.browsercontrol/flows/<id>.json`; the side panel's Flows tab reads and runs the same store
through the bridge.

### PowerShell wrapper

```powershell
function bc { & "D:\dev\dotfiles\tool\browsercontrol\cli\browsercontrol.exe" @args }
```

## Development

See [AGENTS.md](AGENTS.md).

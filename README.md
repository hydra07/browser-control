# browser-control

Chrome extension + local MCP server for driving your everyday Chrome browser
via the debugger (CDP), instead of a separate headless/isolated instance.
Built so an AI client (Claude Code, Antigravity CLI, etc.) can navigate,
click, type, and inspect a real browser tab — reusing whatever cookies and
sessions are already there.

## Architecture

```
MCP client (Claude Code / agy / ...)
        │ stdio (MCP protocol)
        ▼
   src/server/daemon.ts  ── Bun HTTP/WS server (127.0.0.1:8765)
        │ WebSocket
        ▼
   src/extension/offscreen.ts  ── holds the WS, survives SW suspension
        │ chrome.runtime.sendMessage
        ▼
   src/extension/background.ts  ── chrome.debugger (CDP)
        ▼
   Your actual Chrome tab, grouped as "🤖 AI Workspace"
```

`src/` is split by runtime, since the extension (browser) and the server
(Bun/Node) only ever talk to each other over the WebSocket/HTTP wire, never
by importing each other's code:
- `src/extension/` — the Chrome extension (background service worker,
  offscreen document, content script), built by `tsc` into `dist/`.
- `src/server/` — the daemon and replay CLI, run directly via Bun (never
  built; `bun run check:server` type-checks them without emitting).
- `src/shared/` — the wire-protocol types both sides import (`import type`
  only, so it doesn't pull runtime code across the boundary).

`daemon.ts` is spawned directly by the MCP client over stdio and, in the same
process, runs a WebSocket/HTTP server the extension connects out to. There's
no separate step to "start the server" beyond the MCP client launching it.

## Setup

1. Install deps: `bun install`
2. Build the extension: `bun run build`
3. Load unpacked: `chrome://extensions` → enable Developer Mode → *Load
   unpacked* → select this folder.
4. Point your MCP client at `src/server/daemon.ts`:

```json
{
  "mcpServers": {
    "browsercontrol": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/browsercontrol/src/server/daemon.ts"]
    }
  }
}
```

Use an **absolute path to `bun.exe`** instead of the bare `bun` command if
your MCP client spawns processes without your shell's PATH (common on
Windows with version managers like `mise`/`nvm`).

Whenever you change anything under `src/extension/` or `manifest.json`, you
must reload the extension in `chrome://extensions` — MV3 extensions never
pick up source changes automatically.

## Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | Flat, deduplicated text list of interactive elements (id, role, name, value) |
| `browser_query_region` | Same idea, scoped to a CSS selector, returned as a nested tree so a field and its label are siblings |
| `browser_visual_snapshot` | Whole-page snapshot plus a screenshot with a numbered box over every interactive element |
| `browser_inspect_element` | Deep detail on one element: outerHTML, matched CSS rules, computed style, event listeners |
| `browser_click` | Click an element by id — real, trusted mouse event |
| `browser_type` | Focus an element by id and type — real, trusted key events |
| `browser_scroll` | Scroll by a pixel delta |
| `browser_screenshot` | Viewport or full-page screenshot |
| `browser_network_requests` | List XHR/Fetch/Document/WebSocket requests since the last navigate/clear |
| `browser_network_request_detail` | Full headers + body for one request |
| `browser_network_clear` | Clear the network log |
| `browser_evaluate` | Run arbitrary JS — for reading state/setup, not for simulating clicks/typing |

`browser_click`/`browser_type` glide a visible cursor to the target and flash
a corner-bracket highlight before acting, so a human watching the tab can
follow what the agent is doing. Screenshots are off the inline-image path by
default and saved to `screenshots/` on disk instead — see
`BROWSERCONTROL_INLINE_IMAGES` below.

## Observability

- **Session flow warnings**: the daemon tracks recent tool-call history and
  attaches a `_flowWarning` to the response when it detects a known-bad
  pattern (`browser_evaluate` used to simulate clicks, screenshot spam,
  acting without a snapshot, the same node clicked twice in a row) — a live
  nudge instead of relying solely on `instructions` read once at session
  start.
- **Tool-call logging**: every call is logged to `logs/session-<ts>.jsonl`
  (`cmd`, `args`, `durationMs`, `approxTokens`, `hasImage`) so token cost can
  be audited from real data. `mise run replay:list` lists recorded sessions.
- **Replay**: `mise run replay -- logs/session-xxx.jsonl` re-runs a recorded
  session's exact tool calls against the live daemon — reproduce a bug or a
  demo without an LLM agent re-deriving the flow. Requires the daemon
  already running with the extension connected. Add `--continue` to replay
  through errors, `--delay 500` to slow it down for watching.

Set `BROWSERCONTROL_INLINE_IMAGES=true` to have `browser_screenshot`/
`browser_visual_snapshot` include the image inline in the tool response, in
addition to the file on disk. Off by default — some MCP clients can't handle
inline image content from MCP servers, and a mishandled screenshot risks
landing in the model's context as raw base64 text (a single ~700KB PNG is
roughly 230k tokens that way).

## Known limitations

- Single active tab per daemon instance.
- No auth on the WebSocket/HTTP bridge — it binds to `127.0.0.1` only, so
  the threat model is "other processes on this machine," same as most local
  browser-automation MCP servers.
- `browser_evaluate`-based input (`el.value = ...`) does not reliably trigger
  React/Vue's `onChange` — use `browser_click`/`browser_type` for anything
  you want to count as tested interaction.

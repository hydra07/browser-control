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
   src/daemon.ts  ── Bun HTTP/WS server (127.0.0.1:8765)
        │ WebSocket
        ▼
   Chrome extension (src/background.ts)
        │ chrome.debugger (CDP)
        ▼
   Your actual Chrome tab, grouped as "🤖 AI Workspace"
```

`daemon.ts` is spawned directly by the MCP client over stdio and, in the same
process, runs a WebSocket/HTTP server the extension connects out to. There's
no separate step to "start the server" beyond the MCP client launching it.

## Setup

1. Install deps: `bun install`
2. Build the extension: `bun run build`
3. Load unpacked: `chrome://extensions` → enable Developer Mode → *Load
   unpacked* → select this folder.
4. Point your MCP client at `src/daemon.ts`:

```json
{
  "mcpServers": {
    "browsercontrol": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/browsercontrol/src/daemon.ts"]
    }
  }
}
```

Use an **absolute path to `bun.exe`** instead of the bare `bun` command if
your MCP client spawns processes without your shell's PATH (common on
Windows with version managers like `mise`/`nvm`).

Whenever you change `src/background.ts` or `manifest.json`, you must reload
the extension in `chrome://extensions` — MV3 extensions never pick up source
changes automatically.

## Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | Text list of interactive elements (id, role, name, value) |
| `browser_visual_snapshot` | Same, plus a screenshot with a numbered box over every interactive element |
| `browser_click` | Click an element by id — real, trusted mouse event |
| `browser_type` | Focus an element by id and type — real, trusted key events |
| `browser_scroll` | Scroll by a pixel delta |
| `browser_screenshot` | Viewport or full-page screenshot |
| `browser_network_requests` | List XHR/Fetch/Document/WebSocket requests since the last navigate/clear |
| `browser_network_request_detail` | Full headers + body for one request |
| `browser_network_clear` | Clear the network log |
| `browser_evaluate` | Run arbitrary JS — for reading state/setup, not for simulating clicks/typing |

`browser_click`/`browser_type` glide a visible cursor to the target and flash
a colored outline before acting, so a human watching the tab can follow what
the agent is doing. Screenshots are also saved to `screenshots/` on disk as a
fallback for MCP clients that can't render inline image content.

## Known limitations

- Single active tab per daemon instance.
- No auth on the WebSocket/HTTP bridge — it binds to `127.0.0.1` only, so
  the threat model is "other processes on this machine," same as most local
  browser-automation MCP servers.
- `browser_evaluate`-based input (`el.value = ...`) does not reliably trigger
  React/Vue's `onChange` — use `browser_click`/`browser_type` for anything
  you want to count as tested interaction.

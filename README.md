<p align="center">
  <img src="assets/browsercontrol-logo.png" width="112" alt="BrowserControl logo">
</p>

<h1 align="center">BrowserControl</h1>

<p align="center">
  <strong>Give an AI agent the Chrome session you already use.</strong>
</p>

<p align="center">
  Real tabs · existing logins · trusted input · visible automation · local-first MCP
</p>

BrowserControl connects MCP agents to your everyday Chrome browser through the Chrome DevTools Protocol. The agent works inside your real profile—with your cookies, extensions, and authenticated sessions—while you can watch every cursor movement, click, keystroke, scroll, and drag.

It is a Chrome extension plus a local Bun daemon. No Playwright browser, disposable profile, or cloud relay is involved.

## Why BrowserControl?

| | BrowserControl | Headless automation |
|---|---|---|
| Browser state | Your active Chrome profile | Fresh or separately managed profile |
| Authentication | Existing signed-in sessions | Usually requires login setup |
| Input | CDP mouse and keyboard events | Often mixes protocol input with DOM shortcuts |
| Visibility | Live cursor, effects, highlights, panel, and recordings | Commonly hidden or detached from daily browsing |
| Agent context | Compact accessibility snapshots and diffs | Large DOM or screenshot-heavy loops |
| Runtime | Local extension + loopback daemon | Separate browser process and driver |

### Built for agent workflows

- **See before acting.** Accessibility snapshots, targeted search, reading mode, screenshots, layout inspection, and network logs expose only the context the agent needs.
- **Act like a user.** Click, type, press keys, scroll, and drag through CDP while an on-page overlay makes control visible and auditable.
- **Turn work into reusable flows.** Record natural browsing from the side panel, save optimized flows, then replay them in one MCP call.
- **Scale beyond one tab.** Run concurrent crawls, recursive discovery, and asynchronous multi-tab jobs without flooding the active conversation.
- **Keep risky exploration contained.** Confirmation warnings cover destructive targets, while DevTools sandbox mode can block mutating network requests.
- **Audit long runs.** Record WebM sessions and inspect opt-in memory, process, command, and token telemetry.

## Quick start

### 1. Build the extension

BrowserControl uses [Bun](https://bun.sh) workspaces and Turborepo.

```bash
git clone https://github.com/hydra07/browser-control.git
cd browser-control
bun install
bun run build
```

### 2. Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `app/extension/.output/chrome-mv3`.

Click the toolbar icon—or press `Ctrl+Shift+B` / `Command+Shift+B`—to open the side panel.

### 3. Connect an MCP client

Point your MCP client at the daemon entry file:

```json
{
  "mcpServers": {
    "browsercontrol": {
      "command": "bun",
      "args": [
        "run",
        "/absolute/path/to/browser-control/app/server/src/daemon.ts"
      ]
    }
  }
}
```

The daemon binds only to `127.0.0.1:8765`. Keep Chrome open with the extension loaded, then restart or reload your MCP client.

To collect runtime benchmark telemetry, add:

```json
{
  "env": {
    "BENCHMARK": "1"
  }
}
```

## The tool surface

BrowserControl exposes six gateway tools instead of dozens of flat tools. Each gateway accepts an `action` enum plus the parameters for that action, which keeps tool selection compact and predictable.

| Gateway | What it owns | Actions |
|---|---|---|
| `browser_session` | Tabs, navigation, recording, metrics | `navigate`, `list_tabs`, `switch_tab`, `close_tab`, `set_session_name`, `start_recording`, `stop_recording`, `get_metrics` |
| `browser_inspect` | Page, visual, DOM, and network state | `snapshot`, `find`, `reading_mode`, `select_content`, `inspect_element`, `screenshot`, `peek_screen`, `network_requests`, `network_clear` |
| `browser_act` | Trusted interaction and composed flows | `click`, `type`, `press_key`, `scroll`, `drag`, `run_flow`, `evaluate` |
| `browser_bulk` | Work that should run asynchronously | `batch_crawl`, `deep_crawl`, `start_job`, `search`, `task_status` |
| `browser_knowledge` | Durable browser knowledge | `list_skills`, `save_skill`, `list_flows`, `save_flow`, `delete_flow`, `record_flow`, `query_docs` |
| `browser_dev` | Diagnostics, emulation, and containment | `debug_layout`, `emulate`, `sandbox`, `inspect_memory`, `inspect_process`, `analyze_har`, `export_har`, `benchmark_report` |

A typical agent loop is deliberately small:

```text
browser_session  navigate
        ↓
browser_inspect  snapshot
        ↓
browser_act      click / type / run_flow
        ↓
browser_inspect  snapshot diff or peek_screen
```

## Side panel

The extension side panel keeps the human in the loop:

- **Flows** records, saves, and replays browser procedures.
- **Chat** connects installed local CLI agents when enabled.
- **Benchmark** shows Bun memory, extension heap, and drift health.
- **Settings** manages connection state, MCP configuration, tab grouping, animation, and recording quality.

The on-page feedback layer is pointer-transparent, so visual feedback never intercepts the interaction it is describing.

## Architecture

```text
MCP client
    │ stdio
    ▼
Bun daemon ─────────────── 127.0.0.1:8765
    │ WebSocket
    ▼
Extension offscreen document
    │ chrome.runtime messages
    ▼
MV3 service worker ─────── Chrome DevTools Protocol
    │
    ▼
Your real Chrome tabs
```

```text
app/extension/       WXT extension, service worker, offscreen bridge, side panel
app/server/          MCP daemon, SQLite data store, crawlers, jobs, CLI tools
packages/benchmark/  Opt-in runtime and token-economics telemetry
packages/shared/     Extension/server wire-protocol types
```

## Local data and recordings

Session logs, extracted documents, screenshots, recordings, and saved flows stay local:

```text
data/index.sqlite
data/images/
data/videos/
data/logs/
skills/
```

These paths are gitignored because they may contain private browsing artifacts.

Useful data commands:

```bash
bun run --cwd app/server data:status
bun run --cwd app/server data:sessions
bun run --cwd app/server data:show <session-id>
bun run --cwd app/server data:gc
bun run --cwd app/server replay -- <session-log>
```

## Development

```bash
bun run build          # production extension build
bun run check          # TypeScript checks across workspaces
bun run lint           # Biome lint
bun run format         # Biome format
bun run check:all      # complete type + lint verification
```

While iterating on the extension:

```bash
bun run --cwd app/extension dev
```

MV3 does not automatically pick up a production rebuild. After `bun run build`, reload BrowserControl from `chrome://extensions`.

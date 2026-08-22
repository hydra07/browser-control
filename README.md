<img src="app/extension/public/icon/128.png" width="72" align="left" alt="BrowserControl icon">

# BrowserControl

**Give your AI agent a real Chrome tab — not a headless clone.**

A Chrome extension + local MCP server that lets Claude Code, Antigravity CLI, or any MCP client drive *your own* browser via the Chrome DevTools Protocol: your cookies, your logged-in sessions, your extensions — the page exactly as you'd see it, with real trusted clicks and keystrokes instead of `el.click()` calls that skip actual event handlers.

<br clear="left">

## Why this instead of Playwright/Puppeteer?

- 🍪 **Your session, not a fresh profile.** No re-logging into every site before the agent can get to work.
- 👀 **Watchable & Human-Auditable.** Every action glides a visible cursor, ripples, and highlights its target. Built-in high-definition video recording captures runs for human review and debugging without bloating agent token budgets.
- 🔴 **Auto-Flow Recording.** Click "Record Flow" in the side panel, browse naturally in Chrome, and have your interactions automatically transcribed into optimized, reusable automation sequences.
- 🧠 **Built for token budgets, not just capability.** Accessibility-based element diffs instead of full DOM re-dumps, metadata-only listings before full-content fetches, and compact progressive-disclosure reporting.
- 🛑 **Guardrails & Sandboxing.** Actions that look destructive (delete, pay, sign out) require explicit confirmation. DevTools mutation sandboxing intercepts all mutating requests so you can explore unfamiliar UIs risk-free.
- 📊 **Zero-Overhead Self-Benchmarking.** Dedicated `@browsercontrol/benchmark` engine with opt-in runtime telemetry tracking Bun RAM drift and Extension JS Heap stability.
- ⚡ **Scales past one tab when needed.** Concurrent fetch crawling, multi-tab background jobs, and link-following frontier crawlers with async polling.

---

## Quick start

```bash
bun install        # 1. Install workspace dependencies
bun run build       # 2. Build the extension (Turborepo → WXT) into app/extension/.output/chrome-mv3/
```

3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `app/extension/.output/chrome-mv3/`.
4. Point your MCP client at the daemon:

```json
{
  "mcpServers": {
    "browsercontrol": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/browsercontrol/app/server/src/daemon.ts"]
    }
  }
}
```

> **Optional Benchmark Mode:** To enable real-time memory drift analysis and telemetry collection, add `"env": { "BENCHMARK": "1" }` to your MCP configuration or run with `bun run dev:benchmark`.

---

## Architecture

```
MCP client (Claude Code / Antigravity / ...)
        │ stdio (MCP protocol)
        ▼
   app/server/src/daemon.ts          Bun HTTP/WS server (127.0.0.1:8765)
        │ WebSocket
        ▼
   app/extension entrypoints/offscreen  Holds WS, manages screen recording & background tasks
        │ chrome.runtime.sendMessage
        ▼
   app/extension entrypoints/background  chrome.debugger (CDP) & event relays
        ▼
   Your actual Chrome tab, grouped as "🤖 AI Workspace"
```

The monorepo consists of 4 cleanly decoupled workspace packages:
- **`app/extension/`** — The Chrome extension built with [WXT](https://wxt.dev) (Vite + React + Tailwind v4).
- **`app/server/`** — The MCP daemon, WebSocket bridge, SQLite store, and CLI tools run directly via Bun.
- **`packages/benchmark/`** — Dedicated token economics calculator and memory drift telemetry engine (`@browsercontrol/benchmark`).
- **`packages/shared/`** — Wire-protocol TypeScript types (`@browsercontrol/shared`) shared across packages.

---

## The 6 Gateway Tools

Instead of ~30 individual tools that degrade LLM tool-selection accuracy, BrowserControl exposes **6 high-performance gateway tools**. Each tool takes an `action` enum plus action-specific parameters.

### 1. `browser_session` — Tabs & Lifecycle Management

| Action | Description |
|---|---|
| `navigate` | Go to URL. `newTab: true` opens a fresh tab in the AI Workspace without disturbing the active tab |
| `list_tabs` | List tabs in the "🤖 AI Workspace" group (including user-dragged tabs flagged `isNew: true`) |
| `switch_tab` | Switch active target to a specific tab |
| `close_tab` | Close a tab opened during the session |
| `set_session_name` | Assign a human-readable name to the session |
| `start_recording` / `stop_recording` | Capture high-definition WebM video of tab interactions for human auditing (saved directly to disk at `data/videos/`) |
| `get_metrics` | Retrieve token and call summary statistics for the session |

### 2. `browser_inspect` — Visual & DOM Inspection

| Action | Description |
|---|---|
| `snapshot` | Flat, deduplicated list of interactive elements (id, role, name, value). Supports `visual: true` for numbered box overlays |
| `find` | Jump directly to elements matching text, CSS, or XPath |
| `reading_mode` | Extract clean article text (cheaper than DOM snapshot for reading content) |
| `select_content` | Extract clean Markdown from element(s) into queryable SQLite docs blocks |
| `inspect_element` | Inspect outerHTML, matched CSS rules, computed styles, and attached event listeners |
| `screenshot` | Viewport or full-page screenshot saved to disk (`data/images/`) |
| `network_requests` | Filtered log of XHR/Fetch/Document/WebSocket requests since last navigation |
| `network_clear` | Reset the recorded network log |

### 3. `browser_act` — Trusted User Interactions

| Action | Description |
|---|---|
| `click` / `type` / `press_key` | Trusted mouse/keyboard events with visual cursor gliding and ripples |
| `scroll` | Scroll by pixel delta |
| `drag` | Trusted mousedown→move→mouseup sequence (canvas, whiteboard, sliders) |
| `run_flow` | Execute multi-step sequences (`click`, `type`, `press_key`, `wait_for`, `assert_text`, `scroll`, `drag`) in ONE call. `explore: true` reports step-by-step diffs |
| `evaluate` | Execute arbitrary JavaScript for reading state or test setup |

### 4. `browser_bulk` — Asynchronous Bulk Operations

| Action | Description |
|---|---|
| `batch_crawl` | Concurrent `fetch()`-based crawler for public/static pages without opening tabs |
| `deep_crawl` | Recursive link-following crawler up to a specified depth |
| `start_job` | Multi-tab background worker runner for pages requiring login or heavy client-side rendering |
| `search` | Web search returning clean `{title, url, snippet}` results |
| `task_status` | Poll status of an async bulk job or crawl |

### 5. `browser_knowledge` — Reusable Skills, Saved Flows & Auto-Flow

| Action | Description |
|---|---|
| `list_skills` / `save_skill` | Durable per-domain notes (working selectors, site gotchas) that persist across sessions |
| `list_flows` / `save_flow` / `delete_flow` | Persist validated `FlowStep[]` sequences as named, reusable flows |
| `record_flow` | `mode: 'start'` begins recording user interactions in Chrome; `mode: 'stop'` synthesizes optimized `FlowStep[]` and saves automatically |
| `query_docs` | Query extracted docs blocks with `docsAction: 'list' | 'search' | 'read'` |

### 6. `browser_dev` — DevTools Diagnostics & Emulation

| Action | Description |
|---|---|
| `sandbox` | `mode: "block_mutations"` intercepts all POST/PUT/PATCH/DELETE requests on a tab. GET/HEAD pass through normally. Enables risk-free exploration of unfamiliar UIs |
| `emulate` | Device viewport emulation, network throttling (`slow_3g`, `fast_3g`), and CPU slowdown |
| `debug_layout` | Box model metrics, computed CSS, and stacking context analysis for an element |
| `inspect_memory` | JS heap usage, DOM node count, event listener count, and GC pressure |
| `inspect_process` | CPU breakdown (scripting/layout/rendering) and long tasks |
| `analyze_har` / `export_har` | Network traffic summary or export of full HAR 1.2 files |
| `benchmark_report` | Self-benchmark report with progressive disclosure (`focus: 'overview' | 'telemetry' | 'commands' | 'full'`) |

---

## Side Panel & Auto-Flow Recorder

Click the BrowserControl toolbar icon to open the Side Panel featuring 4 specialized tabs:

1. **⚡ Flows**:
   - **🔴 Record Flow**: Start recording your natural browsing interactions (clicks, typing, keyboard shortcuts).
   - **⏹ Stop & Save**: Automatically aggregates and optimizes your actions into a clean `FlowStep[]` sequence saved to SQLite.
   - **▶ Run**: Execute saved flows instantly against the active tab with step-by-step progress tracking.
2. **💬 Chat**: Local agent chat interface connected directly to your installed CLI agents (`agy`, `claude`).
3. **📊 Benchmark**: Live runtime resource stability monitoring displaying Bun RSS RAM, Chrome Extension JS Heap, and memory drift health status (`OPTIMAL`, `STABLE`, `WARNING`, `CRITICAL`).
4. **⚙️ Settings**: Live connection status, MCP snippet copy, tab group customization, and recording quality controls.

---

## Data Management & CLI Tools

All session artifacts (logs, images, videos, docs blocks) are indexed in `data/index.sqlite`. Manage and inspect data using built-in scripts:

```bash
bun run --cwd app/server data:status      # Total sessions, video sizes, docs blocks
bun run --cwd app/server data:sessions    # List recorded sessions and token footprints
bun run --cwd app/server data:show <id>   # Inspect artifacts from a session
bun run --cwd app/server data:gc          # Prune old session data with dry-run protection
bun run --cwd app/server replay -- <file> # Replay a recorded session's tool calls
```

---

## Releasing & Versioning

Extension versioning follows Semantic Versioning in `app/extension/package.json`:

```bash
bun run --cwd app/extension version:bump patch   # or minor / major
git add .
git commit -m "chore: release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

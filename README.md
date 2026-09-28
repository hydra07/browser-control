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

|                | BrowserControl                                          | Headless automation                             |
| -------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Browser state  | Your active Chrome profile                              | Fresh or separately managed profile             |
| Authentication | Existing signed-in sessions                             | Usually requires login setup                    |
| Input          | CDP mouse and keyboard events                           | Often mixes protocol input with DOM shortcuts   |
| Visibility     | Live cursor, effects, highlights, panel, and recordings | Commonly hidden or detached from daily browsing |
| Agent context  | Compact accessibility snapshots and diffs               | Large DOM or screenshot-heavy loops             |
| Runtime        | Local extension + loopback daemon                       | Separate browser process and driver             |

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

The daemon uses a persistent local authentication token. Copy it with:

```bash
bun run --cwd app/server auth:show
```

Paste the value into **Settings → Daemon pairing token**. The extension WebSocket
is considered connected only after this token completes the versioned handshake.
After `auth:rotate`, repeat the pairing step; the old token is invalidated.

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

Capability profiles are opt-in for backwards compatibility. With no
`BROWSERCONTROL_PROFILE`, the daemon keeps the full existing surface. Set one
profile to make the server filter the advertised action enums and reject
unavailable actions at runtime:

| Profile    | Additional boundary                                                            |
| ---------- | ------------------------------------------------------------------------------ |
| `default`  | Safe compact interaction/inspection; no `evaluate`, recording, or bulk actions |
| `advanced` | Adds `evaluate` and all developer diagnostics                                  |
| `evidence` | Adds recording, flow recording, and HAR export                                 |
| `bulk`     | Adds bounded crawl, search, and background-job actions                         |

For example, a least-privilege MCP client can use:

```json
{
  "env": {
    "BROWSERCONTROL_PROFILE": "default"
  }
}
```

The profile is enforced by the daemon, not only described in the prompt. Leave
it unset when running the full compatibility smoke test across all six gateways.

### Runtime benchmark

The server also includes an opt-in real-Chrome runtime benchmark. It expects the
usual authenticated daemon and paired extension to already be running, creates
one temporary tab, runs five bounded scenarios, and closes only that tab when it
finishes:

```bash
mise exec -- bun run --cwd app/server benchmark:runtime
```

The report is stable JSON on stdout and contains character counts, explicit
`heuristic_chars_div_4` token estimates, durations, roundtrips, and expected
recovery calls. It does not include raw browser responses or the daemon token.
The fixed MCP schema/instruction cost is reported separately from runtime
measurements. Use `BROWSERCONTROL_BENCHMARK_RUNS` (1–10, default 1) for repeats;
`BROWSERCONTROL_BENCHMARK_URL` and `BROWSERCONTROL_BENCHMARK_DAEMON_URL` override
the page and daemon origins when needed. The daemon token is read from
`BROWSERCONTROL_AUTH_TOKEN` or the local `data/daemon-auth-token` file.

## The tool surface

BrowserControl exposes six gateway tools instead of dozens of flat tools. Each gateway accepts an `action` enum plus the parameters for that action, which keeps tool selection compact and predictable.

| Gateway             | What it owns                                    | Actions                                                                                                                                               |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_session`   | Tabs, navigation, recording, artifacts, metrics | `navigate`, `list_tabs`, `switch_tab`, `close_tab`, `set_session_name`, `start_recording`, `stop_recording`, `get_metrics`, `get_artifact`            |
| `browser_inspect`   | Page, visual, DOM, network, and evidence state  | `snapshot`, `find`, `reading_mode`, `select_content`, `inspect_element`, `screenshot`, `peek_screen`, `network_requests`, `network_clear`, `evidence` |
| `browser_act`       | Trusted interaction and composed flows          | `click`, `type`, `press_key`, `scroll`, `drag`, `run_flow`, `evaluate`                                                                                |
| `browser_bulk`      | Work that should run asynchronously             | `batch_crawl`, `deep_crawl`, `start_job`, `search`, `task_status`                                                                                     |
| `browser_knowledge` | Durable browser knowledge                       | `list_skills`, `save_skill`, `list_flows`, `save_flow`, `delete_flow`, `record_flow`, `query_docs`                                                    |
| `browser_dev`       | Diagnostics, emulation, and containment         | `debug_layout`, `emulate`, `sandbox`, `inspect_memory`, `inspect_process`, `analyze_har`, `export_har`, `benchmark_report`                            |

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

For pages that rerender frequently, `browser_inspect({action:"snapshot", semantic:true})`
returns a versioned document-scoped snapshot with compact runtime refs. Use its
`ref` together with the returned `documentId` for `browser_act` or
`browser_inspect({action:"inspect_element"})`. Revisions can update after a
same-document rerender without invalidating a confidently reconciled ref;
navigation/document replacement requires a fresh semantic snapshot. The legacy
node-id snapshot remains the default for compatibility.

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
packages/shared/     Dependency-light extension/server wire contract and codecs
```

## Local data and recordings

Session logs, extracted documents, screenshots, recordings, evidence tracks, and saved flows stay local:

```text
data/index.sqlite
data/images/
data/videos/
data/logs/
data/evidence/
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

### Real-Chrome integration smoke tests

The Phase 1.5 harness uses the built extension, a local fixture page, the
loopback daemon, and Chrome's remote-debugging endpoint. It does not use
Playwright, Puppeteer, Selenium, or `--load-extension`.

Provision a dedicated Chrome profile manually once:

1. Build the extension with `bun run build`.
2. Open `chrome://extensions` in that dedicated profile, enable Developer mode,
   and load `app/extension/.output/chrome-mv3`.
3. Pair the extension in Settings using `bun run --cwd app/server auth:show`.
4. Close Chrome before launching it from the harness, or start it yourself with
   remote debugging enabled and use external mode.

To let the harness launch the official Chrome binary, configure environment
variables for the current shell. The profile must already contain the unpacked
extension; the harness intentionally never injects it automatically:

```bash
BROWSERCONTROL_INTEGRATION_LAUNCH_CHROME=true \\
BROWSERCONTROL_INTEGRATION_CHROME_PATH=<path-to-chrome> \\
BROWSERCONTROL_INTEGRATION_PROFILE=<dedicated-profile-path> \\
BROWSERCONTROL_INTEGRATION_EXTENSION_ID=<optional-extension-id> \\
bun run test:integration
```

To attach to an already running dedicated profile instead:

```bash
BROWSERCONTROL_INTEGRATION_DAEMON_MODE=external \\
BROWSERCONTROL_INTEGRATION_CDP_URL=http://127.0.0.1:9222 \\
bun run test:integration
```

The harness reads the persisted daemon token from ignored local data unless
`BROWSERCONTROL_INTEGRATION_AUTH_TOKEN` is explicitly supplied. Never commit
these environment values or a profile path. The command fails with setup
instructions when Chrome remote debugging, the daemon token, or the manually
paired extension is unavailable. CI runs the fast unit suite only unless a
separately approved provisioned test browser is configured.

# BrowserControl

BrowserControl is now a **headless/serverless Chrome DevTools Protocol CLI** for AI agents.

This branch removes the CLI dependency on the Bun daemon, MCP bridge, and Chrome extension for core browser control. The primary runtime is a single Go CLI that connects directly to Chrome CDP over `127.0.0.1:<port>` and launches Chrome itself when needed.

```text
AI agent / shell
    ↓
browsercontrol CLI
    ↓ CDP WebSocket
Chrome / Chromium / Edge
```

## Install / build

```bash
cd cli
go build -o browsercontrol .
```

The CLI discovers Chrome/Chromium/Edge on Windows, macOS, and Linux. If no browser is already listening on the CDP port, it launches one with a persistent local profile under:

```text
~/.browsercontrol/profile
```

Override the data root with:

```bash
BROWSERCONTROL_HOME=/path/to/data browsercontrol status
```

## Usage

```bash
browsercontrol open https://example.com --headless
browsercontrol snapshot --json
browsercontrol click 1
browsercontrol type '#q' 'golang cdp cli'
browsercontrol press Enter
browsercontrol read --max-chars 8000
browsercontrol net list --json --limit 30
browsercontrol dev layout '#app' --json
browsercontrol screenshot --full --out page.jpg
```

## Commands

### Page

```bash
browsercontrol page open https://example.com
browsercontrol page snapshot --json
browsercontrol page read
browsercontrol page find "login"
browsercontrol page select "main article"
browsercontrol page inspect "#submit"
browsercontrol page eval "document.title"
browsercontrol page screenshot --out shot.jpg
```

Top-level aliases are also available:

```bash
browsercontrol open https://example.com
browsercontrol snapshot
browsercontrol read
browsercontrol find "term"
browsercontrol inspect 1
browsercontrol eval "location.href"
browsercontrol screenshot
```

### Input

```bash
browsercontrol input click 1
browsercontrol input type "#email" "user@example.com"
browsercontrol input press Enter
browsercontrol input scroll 0 500
browsercontrol input drag 100 100 400 400
```

Top-level aliases:

```bash
browsercontrol click 1
browsercontrol type "#q" "search text"
browsercontrol press Enter
browsercontrol scroll 0 500
browsercontrol drag 100 100 400 400
```

### Tabs

```bash
browsercontrol tabs list --json
browsercontrol tabs new https://example.com
browsercontrol tabs switch 2
browsercontrol tabs close 2
```

### Network and diagnostics

Network commands are serverless and read the browser page's resource timing buffer. They do not require the extension/daemon. Response bodies are not available unless a future pure-CDP network recorder is attached before navigation.

```bash
browsercontrol net list --json --filter api
browsercontrol net har --out trace.har.json
browsercontrol net clear
```

Developer helpers:

```bash
browsercontrol dev layout "#app" --json
browsercontrol dev memory --json
browsercontrol dev process --json
browsercontrol dev emulate iphone
browsercontrol dev sandbox block_mutations
```

### Local flows

Flows are local JSON files. A flow can be either an array of steps or a document with a `steps` field.

```json
[
  { "action": "navigate", "url": "https://example.com" },
  { "action": "click", "target": "1" },
  { "action": "type", "target": "#q", "text": "hello" },
  { "action": "press_key", "key": "Enter" },
  { "action": "assert_text", "text": "hello" }
]
```

Run a file directly:

```bash
browsercontrol flow run ./flow.json --json
```

Save/list/get/delete local flows under `~/.browsercontrol/flows`:

```bash
browsercontrol flow save login ./login-flow.json
browsercontrol flow list --json
browsercontrol flow get login
browsercontrol flow run login
browsercontrol flow delete login
```

## Flags

```text
--headless                 launch Chrome with --headless=new when not already running
--port <number>            Chrome CDP port, default 9222
--tab <id|index>           target a tab by target ID/prefix or 1-based index
--new-tab                  open URL in a new tab
--json                     machine-readable output
--full                     full-page screenshot
--max-chars <number>       cap text extraction
--limit <number>           cap find/network/select results
--filter <text>            filter network/HAR entries
--device <name>            device preset for dev emulate
--out <file>               output file path
```

## What was removed from the CLI path

The CLI no longer calls:

```text
Bun daemon /execute
MCP stdio bridge
Chrome extension WebSocket
```

Those older app/server and extension sources may still exist in repository history, but this branch's CLI path is CDP-first and serverless.

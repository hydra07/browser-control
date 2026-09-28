# BrowserControl

BrowserControl is an **AI-friendly CLI bridge for the Chrome extension**.

Default architecture for agents:

```text
AI agent / shell
    ↓
browsercontrol extension ...
    ↓ local Go bridge on 127.0.0.1:8765
Chrome extension WebSocket
    ↓
real Chrome tabs / extension service worker
```

The old Bun daemon/MCP bridge is no longer required for CLI usage. Direct CDP commands still exist as a secondary/debug mode, but agents should use `browsercontrol extension ...` by default.

## Build

Windows:

```powershell
cd cli
go mod tidy
go build -o .\browsercontrol.exe .
```

Unix-like shells:

```bash
cd cli
go mod tidy
go build -o ./browsercontrol .
```

## Start the extension bridge

Run this in a terminal and keep it open:

```powershell
.\browsercontrol.exe extension serve --token-file "D:\dev\dotfiles\tool\browsercontrol\data\daemon-auth-token"
```

Then reload/open the BrowserControl Chrome extension. If the extension needs pairing, get the token:

```powershell
.\browsercontrol.exe extension token --token-file "D:\dev\dotfiles\tool\browsercontrol\data\daemon-auth-token"
```

Check connection:

```powershell
.\browsercontrol.exe extension status --token-file "D:\dev\dotfiles\tool\browsercontrol\data\daemon-auth-token" --json
```

Expected:

```json
{
  "extensionConnected": true,
  "version": "go-cli"
}
```

## Recommended AI wrapper

Use a small PowerShell wrapper so agents do not repeat long paths and token flags:

```powershell
$BC = "D:\dev\dotfiles\tool\browsercontrol\cli\browsercontrol.exe"
$BC_TOKEN_FILE = "D:\dev\dotfiles\tool\browsercontrol\data\daemon-auth-token"

function bc {
  & $BC extension @args --token-file $BC_TOKEN_FILE --json
}
```

Agent loop:

```powershell
bc status
bc snapshot
bc click 1
bc snapshot
```

Proceed only when `bc status` reports `extensionConnected: true`.

## AI-friendly commands

All commands below go through the Chrome extension.

### Inspect page

```powershell
bc snapshot
bc read --max-chars 12000
bc find "login"
bc select "main"
bc inspect 1
bc inspect "#submit"
bc peek
bc visual
bc query-region "#main"
```

`snapshot` defaults to compact semantic mode:

```powershell
bc snapshot
```

Equivalent raw command:

```powershell
bc exec snapshot compact=true semantic=true
```

### Navigate

```powershell
bc open https://example.com
bc open https://example.com --new-tab
```

### Actions

```powershell
bc click 1
bc click "#submit"
bc click ref:abc123 --document-id doc123
bc type 2 "hello world"
bc type "#email" "user@example.com"
bc press Enter
bc scroll 800
bc scroll --delta-y 1200
bc drag 100 200 500 200
```

For risky/destructive actions, require explicit user confirmation and pass:

```powershell
bc click 1 --confirm-risky
```

### Screenshot

```powershell
bc screenshot .local/screenshot/AUTH001.png
bc screenshot .local/screenshot/AUTH001.png --format png --full
```

Raw `exec` also accepts normal flags now:

```powershell
bc exec screenshot --full --format png --out .local/screenshot/AUTH001.png
```

### Tabs

```powershell
bc tabs list
bc tabs switch 123
bc tabs close 123
```

### Network

```powershell
bc network list --limit 50
bc network list --filter api --limit 50
bc network detail <requestId> --include-body
bc network clear
bc network har --include-bodies=false
```

### Dev helpers

```powershell
bc dev layout "#app"
bc dev memory
bc dev process
bc dev emulate --device iphone
bc dev sandbox --mode block_mutations
bc dev har
```

### Flows and evidence

Raw bridge commands remain available for advanced payloads:

```powershell
bc exec run_flow @flow.json --return-snapshot
bc exec explore_flow @flow.json --return-snapshot
bc evidence --mode overview
bc start_capture
bc stop_capture
bc start_flow_recording --domain example.com
bc flow_recording_status
bc stop_flow_recording
```

## Raw bridge escape hatch

Use this when a command does not have a shortcut yet:

```powershell
bc exec <command> [key=value|--flag value|@payload.json|inline-json]
```

Examples:

```powershell
bc exec snapshot compact=true semantic=true
bc exec screenshot --full --format png --out .local/screenshot/AUTH001.png
bc exec network_requests --filter api --limit 50
bc exec network_request_detail --request-id abc --include-body
bc exec run_flow @flow.json --return-snapshot
```

## Rules for AI agents

- Use `browsercontrol extension ...` only.
- Do not use direct CDP commands such as `browsercontrol open`, `browsercontrol snapshot`, or `browsercontrol click` unless the user explicitly asks for CDP mode.
- Always check `extensionConnected=true` before browser actions.
- Use shortcut commands first: `snapshot`, `screenshot`, `click`, `type`, `network list`, etc.
- Prefer `ref + documentId` from semantic snapshots; fall back to `nodeId`; then CSS selector.
- Verify after every action with `snapshot`, `read`, `peek`, or `network list`.
- For raw `exec`, command parameters can be `key=value` or normal flags like `--out file`, `--full`, `--format png`.
- Keep `extension serve` running for the whole session.

## Direct CDP mode

Direct CDP commands still exist for debugging and headless automation, but they bypass the extension:

```powershell
.\browsercontrol.exe open https://example.com --headless
.\browsercontrol.exe snapshot --json
```

Use them only when extension mode is not desired.

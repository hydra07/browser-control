# Legacy extension adapter

This guide applies only to `browsercontrol extension <command>` (alias: `ext`). The default CLI commands use direct CDP with a BrowserControl-owned Chrome profile and do not require the extension bridge. The extension adapter remains available for older commands and Flow v2 workflows that have not moved to the direct driver.

## Architecture

```text
agent / shell
  └─ browsercontrol extension <command>
       └─ HTTP + bearer token → 127.0.0.1:8765 bridge
                                  └─ WebSocket → MV3 extension → CDP → browser tabs
```

The bridge is started explicitly in a foreground terminal. There is no MCP server or Bun daemon.

For workflow syntax and recovery rules, see [Legacy workflows](WORKFLOWS.md). For current fixture and data-handling limits, see [Data classification and fixture policy](PRIVACY.md).

## Setup

Build the CLI and extension:

```sh
cd cli && go build -o browsercontrol .
cd app/extension && bun install && bun run build
```

Load `app/extension/.output/chrome-mv3` as an unpacked extension in `chrome://extensions`.

1. Run `browsercontrol extension token`.
2. Open the BrowserControl service-worker console in `chrome://extensions` and set the local pairing token:

   ```js
   const key = "browsercontrol_settings";
   const stored = await chrome.storage.local.get(key);
   await chrome.storage.local.set({
     [key]: { ...stored[key], daemonAuthToken: "PASTE_BROWSERCONTROL_TOKEN_HERE" },
   });
   ```

3. Run `browsercontrol extension serve` in a separate terminal and leave it running.
4. Verify pairing with `browsercontrol extension status --wait 20s`.

Treat the token as a secret. Close the service-worker console after pairing.

Token disclosure based only on an extension Origin header is disabled by default because native clients can forge that header. For trusted local development only, `BROWSERCONTROL_AUTO_PAIR=1` opts into the older origin-pinning handshake on a loopback-bound bridge. This is convenience, not an authentication boundary.

The token can be loaded from `data/daemon-auth-token` (searched from the current directory or executable location), `~/.browsercontrol/daemon-auth-token`, `--token`, `--token-file`, or `BROWSERCONTROL_AUTH_TOKEN`. If pairing fails, inspect the bridge terminal and `~/.browsercontrol/bridge.log`.

Commands do not start the bridge automatically. The legacy `--no-autostart` flag is accepted as a no-op; setting it to false does not enable background startup.

## Agent loop

Run `browsercontrol extension help agent` for a short guide. Observe the current page, act on a fresh node ID or semantic reference, then verify the result with `wait` or another observation.

```sh
browsercontrol extension open https://example.com
browsercontrol extension snapshot
browsercontrol extension click <observed-id> --snap
browsercontrol extension do "type Search 'golang cdp'" "press Enter" "wait Results" "snapshot --grep result"
```

Default output is compact text. `--json` emits one JSON object per invocation. Errors go to stderr and return exit code 1; usage errors return 2. A successful input dispatch does not by itself prove a business outcome. Inspect partial batch results before deciding whether any action should be retried.

## Command reference

```text
open <url> [--new-tab] [--background]   back | forward | reload
snapshot [--grep s] [--limit n] [--region css] [--semantic] [--diff]
find <text|css|xpath>   read   select <css>   peek   inspect <target>
screenshot [file] [--full] [--format png]   visual [file]
click <target>   type <target> <text>   press <key> [target]
scroll [dy|dx dy|up|down]   drag x1 y1 x2 y2   eval <js|@file.js>
wait <text|css|xpath> [--gone] [--timeout 15s]   wait 2s
do "<cmd>" "<cmd>" ...   do - < steps.txt
tabs [list [--all]|switch <id>|close <id>|new <url>]
net [list [filter]|detail <id> [--body]|clear|har [--out f]]
dev layout|memory|process|emulate|sandbox|har
flow run|explore|validate <file|id> | record | stop | status | list | show | save | rm
search <query>   crawl <url...|@urls.txt>   capture start|stop   evidence
status [--wait 20s]   serve   token   exec <raw_cmd> [key=value|--k v|@payload.json]
cdp <command>      direct CDP via rod, bypasses the extension (debug only)
```

Use `browsercontrol extension help <command>` for command-specific options. `--session-id` selects session state; the default session is `go-cli`, and `BROWSERCONTROL_SESSION_ID` can set it. `BROWSERCONTROL_HOME` overrides the state root. Legacy extension sessions do not reserve browser tabs.

Saved flows live in `~/.browsercontrol/flows/<id>.json`. Review a flow's steps and result before rerunning it after an error or timeout; uncertain actions are not automatically replayed.

## Development

After changing the extension, rebuild it and reload BrowserControl in `chrome://extensions`. See [AGENTS.md](../AGENTS.md) for repository checks and conventions.

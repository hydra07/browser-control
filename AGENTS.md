# Agent notes for this repo

User-facing docs (commands, setup) live in [README.md](README.md) — this file is
dev/agent-facing: how the repo is built, where things live, and conventions to
keep when editing it.

## Layout

- `cli/` — the Go CLI and the only host-side runtime. There is no MCP server and
  no Bun daemon any more; don't reintroduce either.
  - `main.go` / `direct.go` / `direct_agent.go` — default entry uses on-demand direct CDP. Browser
    lifecycle and the basic agent command loop work; unmigrated commands fail without a fallback.
    `extension`/`ext` explicitly select the old adapter; `cdp` selects the old Rod debug mode.
  - `internal/driver/cdp/` — thin bounded CDP transport, command-local target/world handles.
    `agent.go`/`agent.js` implement the bounded direct DOM compatibility layer; full vNext page core
    is still separate. Numeric refs live in a document's isolated world, not a disk/CDP handle cache.
  - `internal/session/` — disk state, OS locks, durable tab leases, profile/process ownership.
  - `ext.go` — flag parsing (`parseCLI`), command table, `do` batching, output/exit codes.
  - `ext_commands.go` — one `cmdX` per command; target resolution (`applyTarget`).
  - `ext_render.go` — compact text renderers + per-command help.
  - `ext_session.go` — bridge client, session lock/state under `~/.browsercontrol/sessions/<id>/`,
    base64 → artifact files, MCP-hint rewriting.
  - `internal/extension/` — the bridge (`bridge.go`: HTTP `/status` `/execute`
    `/flows`, WebSocket to the extension), its client, and the shared flow store.
  - `cdp.go`, `cdp_extended.go`, `internal/browser/` — `browsercontrol cdp ...`
    via go-rod; bypasses the extension, debug only.
- `app/extension/` — Chrome extension (WXT). `entrypoints/background.ts`
  (service worker), `entrypoints/offscreen/` (holds the bridge WebSocket),
  `modules/<name>/`. Side Panel and React have been removed (R1-02); setup uses
  the extension service worker console until the fallback pairing contract lands.
- `packages/shared/` — wire-protocol types for the extension (`import type` only).

## Commands

```bash
cd cli && go vet ./... && go test ./... && go build -o browsercontrol.exe .
bun install
bun run check          # tsc across extension + shared
bun run test           # bun tests
bun run build          # WXT build → app/extension/.output/chrome-mv3
bun x biome check app/extension packages
```

Always run `go test ./...` (CLI) and `bun run check` (extension) before
considering a change done. CI runs `gofmt`, `go test`, `go build`.

MV3 extensions never pick up source changes automatically: after any
`app/extension` edit, `bun run build` + reload in `chrome://extensions`.

## CLI design rules (token economy first)

- Default output is compact text for agents; `--json` is single-line JSON.
  Never print base64 — `extractBinary` turns every `*Base64` field into a file path.
- Every command that can fail returns an error; in-band `{error, hint}` from the
  extension becomes a `*cmdError` (exit 1, `error:`/`hint:` on stderr).
  Usage mistakes are `usagef` (exit 2).
- Filtering (`--grep`, `--limit`), text-run merging and diffing happen CLI-side
  so the agent only pays for the lines it asked for.
- Adding a direct command: dispatch/flags in `direct.go`, a neutral driver/session API, help,
  README and acceptance coverage. Do not implicitly dispatch an unmigrated command to the bridge.
- Adding a legacy adapter command: a `cmdX` handler in `ext_commands.go`, its entry in the
  `commands` map (and `aliases`/`mutating` if relevant) in `ext.go`, a line in
  `usage` (`main.go`) and `commandHelp` (`ext_render.go`), plus README.
- Extension commands are the `cmd` names `modules/dispatch/index.ts` switches
  on; `exec <cmd>` reaches any of them raw.
- Hints written in the extension should name explicit adapter CLI commands (`` `browsercontrol extension snapshot` ``),
  not MCP tool calls; `cliHint` only exists to translate stragglers.

## Conventions

- Comments explain **why**, never what. Say only what a reader can't get from
  the code itself: a non-obvious constraint, a gotcha, why an order matters.
- `//` is for a single line only; anything longer is a `/** ... */` block.
  Exported functions/types get at most a one-line doc.
- A module owns its types (`types.ts` in the extension); promote to `libs/` only
  once a second module needs it.
- Strings a `switch` dispatches on belong in an enum/const, not repeated literals.
- `data/` is gitignored (token, local artifacts) — never add tracked content there.
- Don't reach for Playwright/Puppeteer/Selenium — the point is driving the
  user's real, logged-in browser.

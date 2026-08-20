# Agent notes for this repo

User-facing docs (what the tools do, how to install) live in
[README.md](README.md) — this file is dev/agent-facing: how the repo is
built, where things live, and conventions to keep when editing it.

## Layout

Bun/npm workspaces monorepo (Turborepo on top for task orchestration):

- `app/extension/` — Chrome extension (WXT). `entrypoints/background.ts`
  (service worker), `entrypoints/offscreen/` (holds the daemon WebSocket),
  `entrypoints/sidepanel/` (React UI), `lib/*.ts` (shared logic the
  entrypoints import).
- `app/server/` — the MCP daemon and CLI tools, run directly via Bun, never
  built. See [app/server/src/daemon.ts](app/server/src/daemon.ts) below.
- `packages/shared/` — wire-protocol types only, imported via `import type`
  on both sides (no runtime code crosses the extension/server boundary).

## Commands

```bash
bun install          # one install for the whole workspace
bun run build         # turbo run build — builds the extension (WXT)
bun run check          # turbo run check — tsc --noEmit across all 3 packages
bun run --cwd app/server check   # server only
bun run --cwd app/extension check # extension only
```

Always run `bun run check` before considering a change to `app/server` or
`app/extension` done — there's no test suite, this is the only automated
signal.

MV3 extensions never pick up source changes automatically: after any
`app/extension` edit, `bun run build` + reload in `chrome://extensions` is
required to actually see it (or `bun run --cwd app/extension dev` for
WXT's hot-reloading dev server while iterating).

## `app/server/src` structure

`daemon.ts` is intentionally thin — session/data-dir bootstrap, the
WebSocket/HTTP bridge to the extension, and MCP server wiring. Everything
else lives in `lib/`:

| File | Owns |
|---|---|
| `lib/toolSchemas.ts` | The 5 MCP gateway tool definitions + `INSTRUCTIONS` — pure data |
| `lib/toolHandlers.ts` | `handleToolCall` — one action dispatch per gateway |
| `lib/skills.ts` | Per-domain skill CRUD (`skills/<name>/SKILL.md`) |
| `lib/callLog.ts` | JSONL tool-call logging (`data/logs/session-*.jsonl`) |
| `lib/dataStore.ts` | SQLite-backed sessions/docs-blocks/flows (`data/index.sqlite`) |
| `lib/jobs.ts`, `lib/crawl.ts` | Async multi-tab job runner / recursive crawler |
| `lib/sessionFlow.ts` | Live `_flowWarning` nudges from recent tool-call history |
| `lib/types.ts` | Small shared types (`ToolArgs`, `CommandResult`, `ToolCallResponse`) |

Modules that need to talk to the extension take an `execute`/`executeCommand`
parameter (typed `Executor`, defined in `lib/jobs.ts`) rather than importing
`daemon.ts` — daemon.ts owns the WebSocket and nothing else does. Follow
that pattern for new modules instead of reaching back into daemon.ts.

### The gateway-tool pattern

MCP exposes 5 tools (`browser_act`, `browser_inspect`, `browser_session`,
`browser_bulk`, `browser_knowledge`), not one per action — each takes an
`action` enum plus that action's own params. This replaced ~30 separate
per-action tools because a flat tool list that size measurably hurts a
model's tool-selection accuracy; see the commit that introduced it for the
full rationale.

Adding or renaming an action touches **three** places that must stay in
sync — nothing enforces this at compile time, since inputSchema is plain
JSON Schema, not a validated type:

1. `lib/toolSchemas.ts` — the action's entry in the relevant gateway's
   `enum` + its params documented in that gateway's `description` and
   `inputSchema.properties`.
2. `lib/toolHandlers.ts` — the `case` in that gateway's inner `switch`.
3. Any hint/warning string elsewhere that names the old call form —
   `lib/sessionFlow.ts`, `lib/jobs.ts`, `lib/crawl.ts`, and the extension's
   `background.ts`/`lib/*.ts` all have a few (grep `browser_act(`,
   `browser_inspect(`, etc. across `app/` to find them) — plus README's
   Tools section.

A gateway that already has its own list/search/read-style sub-action
(`browser_knowledge`'s `query_docs`) puts that in a **separate** field
(`docsAction`), never reusing the gateway's own `action` name for it.

## Conventions

- Comments explain **why**, not what — keep them to 1-3 lines. Exported
  functions in `lib/*.ts` get a one-line `/** ... */` JSDoc, not a
  multi-paragraph narrative above the function.
- `data/` and `skills/` are gitignored (session logs/screenshots/recordings
  and per-site skill notes are local, possibly-private artifacts) — never
  add repo-tracked content there.
- Don't reach for Playwright/Puppeteer/Selenium as a workaround for
  anything — this project's whole point is driving the user's real,
  already-logged-in browser via CDP, not a fresh automation instance.

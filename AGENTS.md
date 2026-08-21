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
bun run lint           # biome lint . — fast Rust-based linter
bun run lint:fix       # biome lint --write . — auto-fix safe lint rules
bun run format         # biome format --write . — format all code
bun run format:check   # biome format . — check formatting without modifying
bun run check:all      # turbo run check && biome check . — full type + lint suite
bun run --cwd app/server check   # server only
bun run --cwd app/extension check # extension only
```

Always run `bun run check` (or `bun run check:all`) before considering a change done.

MV3 extensions never pick up source changes automatically: after any
`app/extension` edit, `bun run build` + reload in `chrome://extensions` is
required to actually see it (or `bun run --cwd app/extension dev` for
WXT's hot-reloading dev server while iterating).

## `app/server/src` structure

`daemon.ts`, `dataCli.ts`, `replay.ts` are the only top-level files —
thin orchestrators (session/data-dir bootstrap, the WebSocket/HTTP bridge
to the extension, MCP server wiring, or a standalone CLI entry point).
Everything they orchestrate lives under three directories:

| Dir | Owns |
|---|---|
| `configs/` | Cross-cutting config 2+ things need — `paths.ts` (every on-disk location, resolved once relative to itself instead of each module recomputing `../..` math) and `server.ts` (port, host, package version, env flags) |
| `libs/` | Small pieces genuinely shared by 2+ modules — `errorMessage.ts`, `gateways.ts` (the `Gateway`/`*Action` enums), `types.ts` (`ToolArgs`, `CommandResult`, `ToolCallResponse`, `Executor`), `dataCliCommand.ts` |
| `modules/<name>/` | One responsibility each, self-contained: `types.ts` (its structs), `constants.ts` (its tunables), and its main file(s) (`index.ts`, or `schemas.ts`+`handlers.ts` for `tools/`) |

| Module | Owns |
|---|---|
| `modules/tools/` | `schemas.ts` — the 6 MCP gateway tool definitions + `INSTRUCTIONS` (pure data); `handlers.ts` — `handleToolCall`, one action dispatch per gateway |
| `modules/skills/` | Per-domain skill CRUD (`skills/<name>/SKILL.md`) |
| `modules/callLog/` | JSONL tool-call logging (`data/logs/session-*.jsonl`) |
| `modules/dataStore/` | SQLite-backed sessions/docs-blocks/flows (`data/index.sqlite`) |
| `modules/jobs/`, `modules/crawl/` | Async multi-tab job runner / recursive crawler |
| `modules/sessionFlow/` | Live `_flowWarning` nudges from recent tool-call history |
| `modules/cliAgent/` | Sidepanel Chat tab's `claude`/`agy` subprocess backend |

A module never imports another module's `types.ts`/`constants.ts` from
outside — those are that module's own. Cross-module sharing goes through
that module's `index.ts` (or `schemas.ts`/`handlers.ts`) instead, or gets
promoted to `libs/`/`configs/` once 2+ modules genuinely need it (see
Conventions below). Modules that need to talk to the extension take an
`execute`/`executeCommand` parameter (typed `Executor`, in `libs/types.ts`)
rather than importing `daemon.ts` — daemon.ts owns the WebSocket and
nothing else does. Follow that pattern for new modules instead of reaching
back into daemon.ts.

### The gateway-tool pattern

MCP exposes 6 tools (`browser_act`, `browser_inspect`, `browser_session`,
`browser_bulk`, `browser_knowledge`, `browser_dev`), not one per action — each takes an
`action` enum plus that action's own params. This replaced ~30 separate
per-action tools because a flat tool list that size measurably hurts a
model's tool-selection accuracy; see the commit that introduced it for the
full rationale.

Gateway and action names are the `Gateway`/`ActAction`/`InspectAction`/...
enums in `libs/gateways.ts`, not hand-typed string literals — `schemas.ts`
builds each `inputSchema`'s `enum` array from `Object.values(...)` and
`handlers.ts` switches on the same enum members, so the two can't drift
into a typo silently. Adding or renaming an action still touches **three**
places:

1. `libs/gateways.ts` — add the member to that gateway's enum.
2. `modules/tools/schemas.ts` — the action's params documented in that
   gateway's `description` and `inputSchema.properties`.
3. `modules/tools/handlers.ts` — the `case` in that gateway's inner
   `switch`.

Plus any hint/warning string elsewhere that names the old call form —
`modules/sessionFlow/`, `modules/jobs/`, `modules/crawl/`, and the
extension's `background.ts`/`lib/*.ts` all have a few (grep `browser_act(`,
`browser_inspect(`, etc. across `app/` to find them) — plus README's Tools
section.

A gateway that already has its own list/search/read-style sub-action
(`browser_knowledge`'s `query_docs`) puts that in a **separate** field
(`docsAction`, its own `DocsAction` enum), never reusing the gateway's own
`action` name for it.

## Conventions

- Comments explain **why**, never what — code that needs its own logic
  narrated back (`// loop over items` above a `for` loop) gets simplified
  or deleted, not commented. Say only what a reader can't get from the code
  itself: a non-obvious constraint, a gotcha, why an order matters, why the
  obvious approach doesn't work here.
- `//` is for a single line only. Anything that needs more than one line —
  a real multi-part rationale, a documented gotcha — is a JSDoc `/** ... */`
  block, never stacked `//` lines. Exported functions/types get exactly a
  one-line `/** ... */`, not a multi-paragraph narrative — skip the doc
  entirely on a function whose name+signature already say everything it
  would say.
- A module owns the types/structs it operates on — define them in that
  module's own `types.ts`, not pre-emptively hoisted into `libs/`. Promote
  something to `libs/` (or a path to `configs/paths.ts`) only once a
  second module actually needs to import it.
- Hardcoded string literals a `switch`/`case` (or repeated `===`) dispatches
  on belong in an enum (`libs/gateways.ts`, `libs/dataCliCommand.ts`, or a
  module's own `types.ts`), not typed inline at every call site — a typo in
  a string literal fails silently at runtime, a typo'd enum member fails to
  compile.
- `data/` and `skills/` are gitignored (session logs/screenshots/recordings
  and per-site skill notes are local, possibly-private artifacts) — never
  add repo-tracked content there.
- Don't reach for Playwright/Puppeteer/Selenium as a workaround for
  anything — this project's whole point is driving the user's real,
  already-logged-in browser via CDP, not a fresh automation instance.

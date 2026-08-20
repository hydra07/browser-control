<img src="icons/icon128.png" width="72" align="left" alt="BrowserControl icon">

# BrowserControl

**Give your AI agent a real Chrome tab — not a headless clone.**

A Chrome extension + local MCP server that lets Claude Code, Antigravity
CLI, or any MCP client drive *your own* browser via the Chrome DevTools
Protocol: your cookies, your logged-in sessions, your extensions — the page
exactly as you'd see it, with real trusted clicks and keystrokes instead of
`el.click()` calls that skip the actual event handlers.

<br clear="left">

## Why this instead of Playwright/Puppeteer?

- 🍪 **Your session, not a fresh profile.** No re-logging into every site
  before the agent can get to work.
- 👀 **Watchable.** Every click/type glides a visible cursor, ripples, and
  highlights its target — you can see exactly what the agent is doing
  instead of trusting a log line.
- 🧠 **Built for token budgets, not just correctness.** Diffs instead of
  full re-snapshots, metadata-only listings before full-content fetches,
  screenshots off the inline-context path by default — every design
  decision here has a "this cost N tokens in a real session" reason behind
  it (see [Observability](#observability)).
- 🛑 **Guardrails, not just capability.** A step that looks like it deletes,
  pays, or signs out is blocked until you explicitly confirm it.
- 🗂️ **Remembers sites.** Once the agent works out a site's login flow or
  selectors, it saves a reusable "skill" — no re-discovering it next
  session.
- ⚡ **Scales past one tab when the job calls for it.** Concurrent
  fetch-based crawling, multi-tab background jobs, and a real link-following
  frontier crawler, all pollable async instead of blocking one MCP call for
  minutes.

## Quick start

```bash
bun install        # 1. install deps
bun run build       # 2. build the extension into dist/
```

3. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select this folder.
4. Point your MCP client at the daemon:

```json
{
  "mcpServers": {
    "browsercontrol": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/browsercontrol/src/server/daemon.ts"]
    }
  }
}
```

That's it — no separate "start the server" step. The MCP client spawns
`daemon.ts`, which opens a local WebSocket/HTTP bridge on `127.0.0.1:8765`
that the extension connects out to.

> **Windows tip:** if your MCP client spawns processes without your shell's
> PATH (common with version managers like `mise`/`nvm`), use an absolute
> path to `bun.exe` instead of the bare `bun` command.

> **After any code change:** reload the extension in `chrome://extensions`.
> MV3 extensions never pick up source changes automatically — this applies
> to anything under `src/extension/` or `manifest.json`.

## How it fits together

```
MCP client (Claude Code / agy / ...)
        │ stdio (MCP protocol)
        ▼
   src/server/daemon.ts        Bun HTTP/WS server (127.0.0.1:8765)
        │ WebSocket
        ▼
   src/extension/offscreen.ts  holds the WS, survives service-worker suspension
        │ chrome.runtime.sendMessage
        ▼
   src/extension/background.ts  chrome.debugger (CDP)
        ▼
   Your actual Chrome tab, grouped as "🤖 AI Workspace"
```

`src/` is split by runtime — the extension and the server only ever talk
over the WebSocket/HTTP wire, never by importing each other's code:

- `src/extension/` — the Chrome extension (service worker, offscreen
  document, content script), built by `tsc` into `dist/`.
  `src/extension/sidepanel/` is the one exception — a small React app
  bundled separately by `bun build` (see [Side panel](#side-panel--saved-flows)),
  excluded from the plain `tsc` build since it needs JSX/bundling, not
  per-file emit.
- `src/server/` — the daemon and CLI tools, run directly via Bun (never
  built; `bun run check:server` type-checks them without emitting).
- `src/shared/` — the wire-protocol types both sides import via `import
  type`, so no runtime code crosses the boundary.

## Tools

Every tool defaults to whichever tab `browser_navigate`/`browser_switch_tab`
last pointed at. Pass `tabId` (returned by `browser_navigate` or
`browser_list_tabs`) on any tool call to target a specific tab instead —
useful for driving two tabs at once without a `switch_tab` round trip
between every step.

**Navigate & tabs**

| Tool | Does |
|---|---|
| `browser_navigate` | Go to a URL. `newTab`/`background` open a fresh tab without disturbing the current one |
| `browser_list_tabs` | List tabs in the "🤖 AI Workspace" group — including ones you dragged in yourself, flagged `isNew` |
| `browser_switch_tab` | Make a listed tab the active one instead of navigating fresh |
| `browser_close_tab` | Close a tab you opened with `newTab` |

**See the page**

| Tool | Does |
|---|---|
| `browser_snapshot` | Flat, deduplicated list of interactive elements (id, role, name, value). `visual:true` overlays numbered boxes on a screenshot; `selector:"..."` scopes to one container as a nested tree |
| `browser_find` | Ctrl+F-style: jump straight to elements matching text/CSS/XPath instead of scanning a full snapshot |
| `browser_reading_mode` | Clean article text (title + body), cheaper than a snapshot when the goal is reading, not acting |
| `browser_select_content` | Extract clean Markdown from element(s) into a queryable docs block — see [Data management](#data-management) |
| `browser_inspect_element` | Deep dive on one element: outerHTML, matched CSS rules, computed style, event listeners |
| `browser_screenshot` | Viewport or full-page screenshot, saved to disk |

**Act on the page**

| Tool | Does |
|---|---|
| `browser_click` / `browser_type` / `browser_press_key` | Real, trusted mouse/keyboard events — the only tools that count as testing actual user interaction |
| `browser_scroll` | Scroll by a pixel delta |
| `browser_drag` | Real mousedown→move→up sequence, for canvas/whiteboard UI with no DOM element per shape |
| `browser_run_flow` | A whole click/type/press_key/drag/wait_for/assert_text/scroll sequence in ONE call. `explore:true` adds a per-step diff for validating an unfamiliar UI once |
| `browser_evaluate` | Run arbitrary JS for reading state or test setup — not a substitute for click/type |

**Network**

| Tool | Does |
|---|---|
| `browser_network_requests` | List XHR/Fetch/Document/WebSocket calls since the last navigate/clear, or full detail for one request by id |
| `browser_network_clear` | Clear the log (also happens automatically on navigate) |

**Recording**

| Tool | Does |
|---|---|
| `browser_start_recording` / `browser_stop_recording` | Capture a multi-step flow as video instead of a pile of screenshots |

**Bulk reading & crawling** — async, return an id immediately, poll `browser_task_status`

| Tool | Does |
|---|---|
| `browser_batch_crawl` | Concurrent `fetch()`-based crawler for public/static pages — no tabs, no login session, scales to dozens of URLs |
| `browser_deep_crawl` | Recursively follows outbound links from seeds/a search query, to a depth you set |
| `browser_start_job` | Multi-tab task runner for pages that need a real login session or client-side rendering |
| `browser_search` | Clean `{title, url, snippet}` web search results to feed any of the above |
| `browser_task_status` | Poll a job/crawl id — each call reports only what finished since your last check |

**Docs, sessions & skills**

| Tool | Does |
|---|---|
| `browser_query_docs` | List/search/read content saved by the extraction tools above — see [Data management](#data-management) |
| `browser_set_session_name` | Label the current session so it's identifiable later in `mise run data:sessions` |
| `browser_list_skills` / `browser_save_skill` | List/persist durable per-site notes (selectors, flows) so a future session skips rediscovery |
| `browser_list_flows` / `browser_save_flow` | List/persist a validated `browser_run_flow` step sequence as a named, reusable flow — see [Side panel](#side-panel--saved-flows) |

## Behavior worth knowing about

**Per-domain skills** (`skills/<name>/SKILL.md`, mirrors Claude Code's own
`SKILL.md` convention) are durable notes on how to work with a site — pay
the discovery cost once, reuse it forever across sessions on this machine.
`browser_navigate` auto-surfaces a matching skill via `skillHint`.
`skills/` is gitignored by default (a skill can end up holding selectors/
flows for an internal or otherwise private site) — remove it from
`.gitignore` yourself if you specifically want to commit and share yours.

**"🤖 AI Workspace" is a two-way handoff.** Drag an already-open tab into
that group yourself and `browser_list_tabs` is how the agent finds out
(`isNew: true`) — there's no other notification channel, since MCP can't
push anything into the agent's reasoning loop uninvited.

**Visible-by-design actions.** `browser_click`/`browser_type`/
`browser_press_key` glide a cursor to the target, pause, then click/type
with a ripple + highlight — a multi-second animation so a human watching
can follow along, not a bug. `browser_run_flow` steps use a faster, lighter
version so a multi-step script doesn't crawl.

**`browser_run_flow` resolves targets live, never a stale id** — steps
reference elements by `role`+`name` or a CSS selector, resolved fresh at
execution time, since a script is written before later steps' DOM state
exists. It stops at the first step that fails, and blocks any step whose
target looks destructive (delete, cancel, sign out, pay, confirm, ...)
until you re-send it with `confirmRisky: true`. `explore:true` reports a
delta per step instead of a full snapshot — a real fix after full
re-snapshots cost 87k+ tokens (77% of one test session's entire spend)
across just 10 calls.

## Observability

- **Session flow warnings** — the daemon watches recent tool-call history
  and attaches a `_flowWarning` when it spots a known-bad pattern
  (`browser_evaluate` simulating clicks, screenshot spam, acting without a
  snapshot, the same node clicked twice) — a live nudge, since `instructions`
  is only read once at session start.
- **Tool-call logging** — every call lands in
  `data/logs/session-<id>.jsonl` (`cmd`, `args`, `durationMs`,
  `approxTokens`, `hasImage`), so token cost is auditable from real data.
- **Replay** — `mise run replay -- data/logs/session-xxx.jsonl` re-runs a
  recorded session's exact tool calls against the live daemon, to reproduce
  a bug or a demo without an LLM re-deriving the flow.

Set `BROWSERCONTROL_INLINE_IMAGES=true` to have `browser_screenshot`
include the image inline in the response too (off by default — some MCP
clients can't handle inline image content, and a mishandled screenshot can
land in the model's context as ~230k tokens of raw base64).

## Data management

Everything a session produces — its log, screenshots, recordings, and
extracted content — lives under `data/`, indexed in `data/index.sqlite` so
it's queryable instead of a pile of anonymously timestamped files. Crawled/
extracted content is saved as individual **docs blocks** (one row per
page/element, full-text searchable) rather than one ever-growing markdown
file per session.

Nothing is ever deleted automatically. `mise run data:*` inspects and prunes
it by hand:

| Command | Does |
|---|---|
| `data:status` | Totals: sessions, log/image/video sizes, docs block count, index DB size |
| `data:sessions -- [--limit N]` | List sessions: id, name, duration, tool calls, artifact counts |
| `data:show -- <sessionId>` | Full artifact + docs-block listing for one session |
| `data:read -- <blockId>` | Print one docs block's full content |
| `data:search -- "query" [--session <id>]` | Full-text search across saved docs blocks |
| `data:rename -- <sessionId> "name"` | Set a session's human-readable name |
| `data:gc -- (--session <id> \| --older-than <Nd> \| --keep-last <N>) [--yes]` | Delete old session data — dry-run by default, requires an explicit filter (no implicit "delete everything") |

## CI/CD & releasing

`manifest.json`'s `version` is the single source of truth — `daemon.ts`
reads it live for its own MCP server version, and `bun run build` syncs it
into `package.json` automatically, so the three no longer drift
independently the way they used to.

- **CI** (`.github/workflows/ci.yml`): every push and PR to `master` type-
  checks the extension and the server, runs a full build, and fails if that
  left `package.json`'s version out of sync (i.e. someone bumped
  `manifest.json` without rebuilding/committing the sync).
- **Release** (`.github/workflows/release.yml`): pushing a `vX.Y.Z` tag
  builds the extension, verifies the tag matches `manifest.json`'s version,
  zips `manifest.json` + `dist/` + `icons/` together, and attaches it to a
  new GitHub Release with auto-generated notes. It does **not** publish to
  the Chrome Web Store — that needs API credentials this repo doesn't have
  configured; download the release zip and **Load unpacked** it instead.

To cut a release:

```bash
bun run version:bump patch   # or minor / major / an explicit X.Y.Z
git add manifest.json package.json
git commit -m "chore: bump version to vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags   # this is what triggers release.yml
```

## Side panel & saved flows

Click the extension's toolbar icon to open a side panel (React, bundled
with Bun's own bundler — no extra build-tool dependency) listing every flow
saved with `browser_save_flow`: name, description, domain badge, step
count. Click the ▶ button and it runs immediately against the current tab
— same `runFlowSteps` engine `browser_run_flow` itself uses, driven through
the daemon's existing `127.0.0.1:8765` HTTP server (`GET /flows`, `POST
/flows/:id/run`), since the panel is a browser page, not an MCP client.

A flow is meant for something you (or your agent) already validated and
expect to re-run — not authored in the panel itself. The panel polls every
5s so a flow saved from any session shows up without a manual refresh.

**Deliberately not built (yet)**:
- **Visual flow composition** (chaining/branching steps as a node graph,
  the way some other browser-automation extensions do with a full DAG
  editor) — flows here stay linear `FlowStep[]` sequences run through the
  existing engine. A much bigger surface; revisit only if linear sequences
  turn out to be a real limitation in practice.
- **A chat box in the panel that messages the agent** — not achievable
  without browsercontrol itself embedding an LLM/agent loop the way some
  similar projects do (their own server calls an LLM API directly with its
  own sessions); this daemon is deliberately just an MCP tool *provider*
  with no reference to, or channel into, whatever external MCP client
  (Claude Code, Antigravity, ...) is calling it. If this is wanted later,
  the realistic version within this architecture is a pollable inbox (the
  panel writes a note, a new MCP tool lets the agent check for it on its
  own next turn — the same poll pattern `browser_task_status` already
  uses), not a live push channel.

## Known limitations

- Recording and the network log are scoped to one tab per daemon instance,
  even though click/type/snapshot/etc. can target several.
- No auth on the WebSocket/HTTP bridge — it binds to `127.0.0.1` only, so
  the threat model is "other processes on this machine," same as most local
  browser-automation MCP servers.
- `browser_evaluate`-based input (`el.value = ...`) doesn't reliably trigger
  React/Vue's `onChange` — use `browser_click`/`browser_type` for anything
  you want to count as tested interaction.

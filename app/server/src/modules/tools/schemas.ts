/**
 * MCP tool surface: 6 gateway tools instead of one per action (32 of them
 * at last count — browser_click, browser_navigate, browser_snapshot, ...).
 * Each takes `action` (which of that gateway's actions to run) plus that
 * action's own params, flattened into one property bag per gateway. Same
 * "one param bag, `action`-tagged description per field" shape
 * FLOW_STEP_ITEM_SCHEMA already used for run_flow's steps, one level up.
 *
 * Grouped by response shape, not alphabetically — act (sync DOM actions),
 * inspect (sync reads), session (tab/recording lifecycle), bulk (async,
 * id+poll), knowledge (persisted-state CRUD), dev (diagnostics/emulation)
 * — so mixing e.g. a sync click with an async start_job in the same
 * gateway never makes "what does this call return" unpredictable.
 *
 * Pure data — no server/WebSocket state — so this stays importable from
 * anywhere without pulling in daemon.ts.
 */

import {
  ActAction,
  BulkAction,
  DevAction,
  DocsAction,
  Gateway,
  InspectAction,
  KnowledgeAction,
  SessionAction,
} from "../../libs/gateways.js";
import { MAX_CONCURRENT_CRAWLS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES } from "../crawl/constants.js";
import { MAX_CONCURRENT_JOBS, MAX_JOB_TASKS } from "../jobs/constants.js";
import { FLOW_STEP_ITEM_SCHEMA, TAB_ID_PROPERTY } from "./constants.js";

export { FLOW_STEP_ITEM_SCHEMA, TAB_ID_PROPERTY };

/** Read once at MCP session start (not per-call) — workflow/judgment guidance that doesn't fit in any one tool's description. Uses `gateway.action` shorthand for `browser_gateway({action:"action", ...})`. */
export const INSTRUCTIONS = `
This server exposes 6 GATEWAY tools instead of one tool per action —
browser_act, browser_inspect, browser_session, browser_bulk,
browser_knowledge, browser_dev — each taking an \`action\` enum plus that
action's own params, e.g. browser_act({action:"click", nodeId}). Below,
\`gateway.action\` is shorthand for that call shape (\`session.navigate\` means
browser_session({action:"navigate", ...})). Call the matching gateway's
inputSchema to see every action's exact param list — this instructions
block covers workflow and judgment calls, not full param reference.

Progressive disclosure: default calls return compact summaries (snapshot,
inspect_memory, inspect_process, analyze_har, debug_layout all default to a
short overview) — use \`focus\`/\`detail\` params to drill into a specific
problem instead of requesting full detail up front. session.get_metrics
reports token usage/savings if you want to check.

BrowserControl drives real Chrome tabs (grouped as "🤖 AI Workspace") via
your everyday browser's debugger, not a headless/isolated instance. Every
action defaults to whichever tab session.navigate/session.switch_tab last
pointed at. To work with more than one tab at once, pass tabId (from
session.navigate or session.list_tabs) on any act/inspect call to target
that tab regardless of which one is "current" — no switch_tab round trip
needed. Open an extra tab without disturbing the current one via
session.navigate({url, newTab:true}); its response's tabId is what you
reuse. Each tab keeps its own CDP session, but session.start_recording/
stop_recording and the network log (inspect.network_requests/clear) stay
scoped to a single tab regardless.

For "go read/extract N pages" work, don't drive it yourself with N
sequential navigates. Public/static content at volume: bulk.batch_crawl (or
bulk.deep_crawl to also follow links, to a depth you set) — no tab
overhead, scales to dozens of pages. Pages needing a real login session or
client rendering: bulk.start_job — same idea, real tabs. bulk.search gets
clean {title,url} results to feed either instead of navigating to a search
engine yourself. start_job/deep_crawl return an id immediately and keep
working in the background — poll bulk.task_status(taskId); each poll only
returns what finished since your last check, so it's cheap to poll often.

Content from inspect.select_content/bulk.batch_crawl/deep_crawl/start_job
is saved as individual docs blocks (SQLite-backed, not one growing file) —
each call returns the new block id(s); knowledge.query_docs reads one back
({docsAction:"read", blockId}) or searches everything saved this session,
or ever with allSessions:true ({docsAction:"search", query}).
session.set_session_name({name}) labels a session worth finding again
later — optional, sessions auto-name from hostnames visited otherwise.

"🤖 AI Workspace" is a two-way handoff: the user can drag a tab they
already have open into that group themselves, and session.list_tabs is the
only way you'd find out (there's no way to interrupt you mid-turn). Call it
at session start and whenever the user references a tab they already have
open; isNew:true flags ones added since you last checked. session.switch_tab
on the result to start working on it.

"Unknown command: <name>" with a version-mismatch hint means the Chrome
extension is an older build than this daemon (MV3 never auto-updates —
reloading in chrome://extensions is required). Tell the user to reload and
retry. Do not work around this with Playwright/Puppeteer/Selenium or a
custom screenshot script — it's a stale extension, not a capability gap.

Workflow for interacting with a page:
1. session.navigate. A skillHint in the response means a skill already
   exists for this domain — read it before exploring; it may already have
   the selectors/flow you're about to rediscover. No hint doesn't mean no
   skill exists — check knowledge.list_skills if unsure.
2. inspect.snapshot for a fast text list of interactive elements (id, role,
   name, value). Not confident which id is right (custom dropdowns,
   icon-only buttons, repeated labels)? inspect.snapshot({visual:true})
   draws numbered boxes over every interactive element on a screenshot so
   you can ground the id to a position first.
3. act.click / act.type using that id — real, trusted input events, same
   as a physical mouse/keyboard, so they exercise the actual handlers.
4. act.type only inserts text, never submits. Follow it with
   act.press_key (Enter, Tab, Escape, arrows...) to submit or navigate a
   custom dropdown.
5. Never call click/type/press_key/drag/scroll one-by-one in a loop for a
   multi-step sequence — pack them into one act.run_flow call. 5-10 slow
   roundtrips become one fast execution.
6. Write a multi-step flow (login, form fill, search) as steps referencing
   elements by role+name (from the snapshot) or CSS selector, in one
   act.run_flow call. Default to plain run_flow, not explore:true (see
   browser_act's run_flow notes for why — it's the single biggest measured
   token cost this tool has when left on past the first validation run).
7. Once a site's selectors/flow are worked out, save with
   knowledge.save_skill so a future session skips the rediscovery cost —
   check knowledge.list_skills first and update an existing skill rather
   than duplicating. Skip this for a genuine one-off task.

Exploratory safety: turn on dev.sandbox({mode:"block_mutations"}) — see
browser_dev for the mechanism — before clicking anything that could be a
real save/submit/delete/checkout on a site you're still discovering (or
under explore:true) and haven't been explicitly told to trigger for real.
Turn it back off once you're done exploring or the user asks for the real
action — and say so either way, so the user is never left assuming a click
hit the real server when it didn't, or vice versa.

Action selection: each gateway's own inputSchema description already
covers what each action does and when to reach for it (snapshot vs find vs
reading_mode vs inspect_element vs screenshot, evaluate vs click/type,
recording, etc.) — read that instead of this block repeating it. The one
rule worth stating here because it's about how you report your work, not
about any single action: only act.click/type/press_key/run_flow count as
testing real user interaction. If you used act.evaluate to fill a field or
click via JS as a shortcut, say so explicitly rather than reporting it as
a tested interaction — setting element.value via JS doesn't reliably
trigger React/Vue's onChange, so a broken input can look like it works.

Inspecting the network call behind a submit/action button:
1. inspect.network_clear right before the click, so page-load noise
   doesn't drown out the call you care about.
2. act.click the button.
3. inspect.network_requests — defaults to XHR/Fetch/Document/WebSocket
   only, not static assets.
4. inspect.network_requests again with requestId set for full headers/
   body (payload sent, error message returned).
Also auto-clears on every session.navigate.

act.run_flow's risky-action guard (destructive-looking step names, see its
own description) only catches name-matched steps — dev.sandbox (above) is
the broader net, catching any mutating HTTP call regardless of how it's
triggered.

knowledge.save_flow persists a validated run_flow sequence (name + steps)
as reusable — it gets a Run button in the side panel for a human to re-run
without you. Save one worth re-running later (a login, a recurring form),
not a one-off. Check knowledge.list_flows first and pass an existing flow's
id to update it instead of duplicating.

A timeout/error's "hint" field usually names the actual cause (stale node
id, extension not connected, unhandled dialog) — check it before retrying
blindly.
`.trim();

export const TOOLS = [
  {
    name: Gateway.Act,
    description: `Perform a real, synchronous action on the current page. Set \`action\` to one of: click, type, press_key, scroll, drag, evaluate, run_flow.

click / type / press_key / run_flow are the ONLY actions that count as testing real user interaction — they dispatch real, trusted mouse/keyboard events, the same as a physical mouse/keyboard, not \`el.click()\`-style calls that skip actual event handlers. Standalone click/type/press_key glide a visible cursor to the target and briefly outline it (violet for click, cyan for type/key) — a multi-step animation (glide, pause, press, ripple) taking a couple of seconds, so a human watching the tab can follow along. This is intentional latency, not a bug. run_flow's steps use a faster, lighter version so a multi-step script doesn't crawl.

- click: click the element with this nodeId (from browser_inspect's snapshot action).
- type: focus nodeId (omit only if already focused) and type text as a real user would, one CDP input event at a time. Only inserts text — never submits anything on its own; follow with press_key (Enter) to submit.
- press_key: dispatch a real keydown/keyup, distinct from type. A named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown) for form/navigation use, or a single character to trigger a keyboard-shortcut listener directly — canvas/whiteboard apps (Excalidraw and similar) commonly bind tool selection to single letters rather than exposing DOM buttons. Never inserts text.
- scroll: scroll by a pixel delta (deltaX/deltaY).
- drag: a real mousedown->mousemove(*n)->mouseup sequence between two viewport points (fromX/fromY/toX/toY), not a click — for canvas-based UI (a whiteboard, a drawing app) with no DOM element per shape to click/type into.
- evaluate: run arbitrary JavaScript (expression) for reading state (localStorage, computed values) or test setup/teardown — NOT a shortcut for clicking buttons or filling fields: setting element.value via JS does not reliably trigger React/Vue's onChange, so a broken input can look like it works when it doesn't. If you used this to fill a form, say so explicitly rather than reporting it as a tested interaction.
- run_flow: run a list of steps (click/type/press_key/drag/wait_for/assert_text/scroll) in ONE call instead of one round trip per step. Steps target elements by role+name (from a prior snapshot) or a CSS selector, resolved fresh against the live page at execution time — except drag, addressed by raw viewport coordinates. Stops at the first step that doesn't resolve or fails, returns a compact per-step report. Plain mode (default) omits full final snapshot to save tokens (set \`returnSnapshot:true\` if needed). Two modes: plain (default) for a sequence you're already confident in, one clean run. \`explore:true\` adds a \`delta\` (added/changed/removed elements vs. the previous step) to every step's result — use it ONCE to validate a best-guess sequence against an unfamiliar UI before switching back to plain mode; it is NOT a safe preview, every step still has the same real side effects. Don't default to explore:true once a sequence is validated — repeated explore calls for a flow you already know works is the most common way this wastes tokens (on a real multi-scenario test session, 10 explore:true calls alone accounted for over 75% of that session's total tool-call tokens). A step whose target looks destructive/irreversible (delete, cancel, sign out, pay, confirm, ...) is blocked by default in both modes; if that's actually intended, confirm with your user and re-run with that step's confirmRisky:true.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(ActAction) },
        nodeId: {
          type: "number",
          description: "Element to act on (click), or to focus first (type/press_key — omit only if already focused).",
        },
        text: { type: "string", description: "Text to type (action: 'type')." },
        key: { type: "string", description: "Key to press (action: 'press_key')." },
        deltaX: { type: "number", description: "Scroll delta (action: 'scroll')." },
        deltaY: { type: "number", description: "Scroll delta (action: 'scroll')." },
        fromX: { type: "number", description: "Drag start x, viewport pixels (action: 'drag')." },
        fromY: { type: "number", description: "Drag start y, viewport pixels (action: 'drag')." },
        toX: { type: "number", description: "Drag end x, viewport pixels (action: 'drag')." },
        toY: { type: "number", description: "Drag end y, viewport pixels (action: 'drag')." },
        shape: {
          type: "string",
          enum: [
            "straight",
            "circle",
            "arc",
            "ellipse",
            "bezier",
            "sine",
            "zigzag",
            "spiral",
            "waypoints",
            "polygon",
            "star",
            "heart",
            "flower",
            "rectangle",
            "box",
            "parametric",
            "polar",
            "function",
          ],
          description: "Geometric or mathematical function trajectory shape (action: 'drag').",
        },
        shapeParams: {
          type: "object",
          description:
            "Parameters for shape drag: math formulas {fnX, fnY, fnR, tMin, tMax}, center {cx, cy}, radius {radius, radiusX, radiusY}, angles {startAngle, endAngle}, or presets {petals, numPoints, outerRadius, innerRadius, size, width, height}.",
        },
        path: {
          type: "array",
          description: "Array of [x, y] or {x, y} coordinate waypoints for path dragging (action: 'drag').",
        },
        stepsCount: { type: "number", description: "Number of intermediate interpolation steps for drag." },
        easing: {
          type: "string",
          enum: ["linear", "easeIn", "easeOut", "easeInOut"],
          description: "Easing function for drag movement.",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button for drag (default 'left').",
        },
        expression: { type: "string", description: "JavaScript to evaluate (action: 'evaluate')." },
        steps: {
          type: "array",
          description:
            "Ordered list of steps (action: 'run_flow'). Stops at the first step that doesn't resolve or fails.",
          items: FLOW_STEP_ITEM_SCHEMA,
        },
        explore: {
          type: "boolean",
          description:
            "(action: 'run_flow') Add a per-step delta to validate an unfamiliar/best-guess sequence once, instead of a plain run. Don't default to this once a flow is validated — see the tool description.",
        },
        returnSnapshot: {
          type: "boolean",
          description:
            "(action: 'run_flow') Set true to return full final accessibility snapshot after completing the flow. Defaults to false to conserve tokens.",
        },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
  {
    name: Gateway.Inspect,
    description: `Read/observe the current page without acting on it. Set \`action\` to one of: snapshot, find, reading_mode, inspect_element, screenshot, select_content, network_requests, network_clear, peek_screen.

- snapshot: the default way to see what's on the page before clicking/typing. Plain call: a flat list, {i,r,n,v?} per entry (i=node id for browser_act/inspect_element, r=role, n=accessible name, v=current value if any). Set \`compact:true\` to get a dense single-line format saving ~75% token whitespace. \`visual:true\` also returns a screenshot with a numbered box over every interactive element (same ids) — use before clicking anything you're not 100% sure about (custom dropdowns, icon-only buttons, ambiguous labels). \`selector:"..."\` scopes to one container (a form/panel/row) and returns a NESTED tree instead of a flat list — a field's label ends up as its sibling in the same \`children\` array; capped at 150 elements, narrow the selector if truncated. If both are set, visual wins (selector-scoped + visual together isn't supported).
- peek_screen: safely observe and read the user's currently active screen/tab (even if outside the AI Workspace) in pure READ-ONLY mode — captures URL, title, selected text, visible page text, and optional visual screenshot for vision models. Strictly read-only: does not click, mutate, or navigate the tab. Use when the user asks you to look at their screen, summarize the page they are viewing, or gather context from open tabs.
- find: Ctrl+F-style — jump straight to elements matching text/CSS selector/XPath (\`query\`) instead of scanning a full snapshot. Much cheaper than snapshot when you already know what you're looking for on a large/data-heavy page. Returns the same {i,r,n} shape as snapshot, usable directly with browser_act. Flashes a highlight on the first match.
- reading_mode: clean article/main-content text (title + body, chrome like nav/ads/sidebars stripped) — like a browser's reader view. Far cheaper than snapshot when the goal is READING content, not acting on interactive elements. Says so and returns nothing useful on non-article pages (an app UI, a form, a dashboard) — fall back to snapshot there.
- inspect_element: deep-dive on ONE element by nodeId — outerHTML, which CSS rule/selector set its computed styles, key computed layout properties, and any event listeners attached (type only, not handler source). Expensive relative to snapshot — use only for the specific element you need to explain, not in a loop.
- screenshot: viewport or full-page (\`fullPage:true\`) screenshot for visual inspection (layout, spacing, colors) the accessibility tree can't show — saved to disk, path returned in the text output. Never pass format:"png" unless you specifically need pixel-exact color values — it's 3-5x larger than the jpeg default for no benefit in routine "let me see the page" checks. Inline image content is OFF by default (BROWSERCONTROL_INLINE_IMAGES=true to enable) — some MCP clients can't render it, and a mishandled screenshot risks landing in context as raw base64 (~230k tokens for a ~700KB PNG).
- select_content: extract clean Markdown (headings, links, lists, code, emphasis preserved) from element(s) — \`selector\` (CSS, matches multiple elements, each its own block) or \`nodeId\` (exactly one). Does NOT return the extracted content in the response — every matched element is saved as its own docs block (see browser_knowledge's query_docs) and you get back the new block id(s) plus a short preview. If you need a small amount of text back immediately instead, use reading_mode, not this.
- network_requests: list network requests observed since the last navigate/clear — like the DevTools Network tab. Plain call defaults to XHR/Fetch/Document/WebSocket only, hiding static asset noise unless \`resourceTypes\` is passed explicitly. Pass \`requestId\` (from a prior call) instead for full detail on that ONE request — headers, post body, response body — ignoring resourceTypes/filter/limit.
- network_clear: clear the network log. Call immediately before a submit/action click so a following network_requests only shows what that action triggered. Also happens automatically on browser_session's navigate action.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(InspectAction) },
        compact: {
          type: "boolean",
          description:
            "(action: 'snapshot') Return dense 1-line-per-node text format instead of multi-line JSON, saving ~75% tokens. Recommended for large DOMs.",
        },
        visual: {
          type: "boolean",
          description:
            "(action: 'snapshot') Also return an annotated screenshot with numbered boxes over interactive elements.",
        },
        selector: {
          type: "string",
          description:
            "CSS selector — scopes into a nested tree (action: 'snapshot'), or the elements to extract (action: 'select_content').",
        },
        query: { type: "string", description: "Text, CSS selector, or XPath to search for (action: 'find')." },
        limit: { type: "number", description: "Max matches to return, default 20 (action: 'find')." },
        nodeId: {
          type: "number",
          description: "Element id, from a prior snapshot/find (action: 'inspect_element' or 'select_content').",
        },
        maxChars: {
          type: "number",
          description:
            "Cap on returned/extracted text length (action: 'reading_mode', default 20000; or 'select_content', default 20000 per call; or 'peek_screen', default 15000).",
        },
        maxMatches: {
          type: "number",
          description: "Max elements to extract when using selector, default 20 (action: 'select_content').",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page instead of just the viewport (action: 'screenshot').",
        },
        format: {
          type: "string",
          enum: ["jpeg", "png"],
          description:
            "(action: 'screenshot') Leave unset (defaults to jpeg) — see the tool description for why png is almost never worth it.",
        },
        quality: { type: "number", description: "JPEG quality 0-100, default 80 (action: 'screenshot')." },
        screenshot: {
          type: "boolean",
          description:
            "(action: 'peek_screen') Also capture visual JPEG screenshot of the active screen for multimodal vision inspection.",
        },
        resourceTypes: {
          type: "array",
          items: { type: "string" },
          description:
            "(action: 'network_requests') CDP resource type names (XHR, Fetch, Document, Script, Stylesheet, Image, Font, Media, WebSocket, ...). Overrides the default filter.",
        },
        filter: {
          type: "string",
          description: "(action: 'network_requests') Only include requests whose URL contains this substring.",
        },
        requestId: {
          type: "string",
          description: "(action: 'network_requests') Get full detail for this one request instead of listing.",
        },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
  {
    name: Gateway.Session,
    description: `Manage tabs and the current daemon session — not page content. Set \`action\` to one of: navigate, list_tabs, switch_tab, close_tab, set_session_name, start_recording, stop_recording, get_metrics.

- navigate: go to a URL. By default reuses whichever tab is currently active. Pass newTab:true to open this URL in a NEW tab instead, keeping the current one where it is — the response's \`tabId\` is then what you pass as \`tabId\` on later browser_act/browser_inspect calls to keep driving that specific tab. Pass an existing \`tabId\` to re-navigate that specific tab in place. If the response includes a skillHint field, a skill already exists for this domain (see browser_knowledge's list_skills/save_skill) — read it before exploratory work.
- list_tabs: list open tabs in the browser. By default ('workspace') lists tabs currently in the "🤖 AI Workspace" tab group where AI has full interactive control. Set \`scope:'all'\` to list all browser tabs with their inWorkspace status and permissions ('control' vs 'read_only').
- switch_tab: make an existing tab (from list_tabs) the active one for subsequent browser_act/browser_inspect calls that omit tabId, instead of navigating to the same URL fresh.
- close_tab: close a tab by id (from navigate/list_tabs) — tidy up a tab opened with navigate({newTab:true}).
- set_session_name: label this daemon session with a short human-readable name so \`mise run data:sessions\`/\`data:show\` can identify it later instead of just a timestamp. Not required — sessions auto-name from the hostnames visited; use this when that's not descriptive enough.
- start_recording: start recording the active tab as video (no audio, no other tabs) — for a multi-step flow (wizard, drag, animation) you want to review as motion rather than a stack of screenshots. Only one recording at a time. Call stop_recording when done.
- stop_recording: stop the recording, save it as a .webm file, and return its path. Errors if none is in progress.
- get_metrics: get real-time token benchmark analytics for the current session (or allSessions:true) — total tokens, tool call count, duration, breakdown by command, recent call history, and estimated token savings.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(SessionAction) },
        url: { type: "string", description: "(action: 'navigate')" },
        newTab: {
          type: "boolean",
          description:
            "Open in a new tab instead of reusing the current one (action: 'navigate'). Ignored if tabId is set.",
        },
        tabId: {
          type: "number",
          description:
            "Target tab. For 'navigate': re-navigate this specific existing tab instead of the current/a new one. For 'switch_tab'/'close_tab': the tab to act on (required).",
        },
        name: { type: "string", description: "(action: 'set_session_name')" },
        scope: {
          type: "string",
          enum: ["workspace", "all"],
          description:
            "(action: 'list_tabs') 'workspace' (default) lists only AI Workspace tabs; 'all' lists all open tabs across the browser.",
        },
        allSessions: {
          type: "boolean",
          description: "(action: 'get_metrics') Include metrics across all sessions instead of just current session.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: Gateway.Bulk,
    description: `Async/bulk multi-page work — the async actions return an id almost immediately and keep working in the background; poll with action:'task_status'. Set \`action\` to one of: batch_crawl, search, deep_crawl, start_job, task_status.

- batch_crawl: concurrent \`fetch()\`-based crawler for heavy workloads — fetch and extract clean Markdown from multiple URLs (\`urls\`, max 100/call) in parallel without opening visible tabs. Automatically extracts metadata (Title, Author, Published Date, Reading Time) and outbound links, applies Readability heuristics, dedupes against every URL already crawled this session, and saves each page as its own docs block. Returns a compact execution summary and the new block ids, never the extracted content itself. Unlike every other action here, this does NOT go through a real browser tab — no cookies/login session, no JavaScript. Only use for public, mostly-static pages (docs, blog posts, wikis) — it silently returns thin/empty results on a login-gated or JS-rendered page, not an error. For recursively following the links a crawl turns up, use deep_crawl instead of calling this in a loop.
- search: run a web search and get back clean {title, url, snippet} results — feed into batch_crawl/start_job/deep_crawl instead of navigating to a search engine and parsing the results page yourself. Same fetch()-based mechanism as batch_crawl (no login session, no JS) via DuckDuckGo's HTML endpoint.
- deep_crawl: recursive crawl — start from \`seedUrls\` and/or a \`searchQuery\`, follow the outbound links pages turn up, up to \`depth\` hops deep, automatically. A continuous pool of \`concurrency\` workers drains a shared queue (a real frontier, not depth-by-depth batches). Built on the same per-page fetch as batch_crawl (same no-login caveat). Returns a crawlId almost immediately; poll task_status — each call only reports pages that finished since your last check. Each page saved as its own docs block as it finishes; this never returns crawled content directly. Max ${MAX_CRAWL_DEPTH} depth, max ${MAX_CRAWL_PAGES} total pages, ${MAX_CONCURRENT_CRAWLS} crawls running at once.
- start_job: async multi-tab task runner: give it a list of URLs (\`tasks\`, each with what to extract), it opens up to \`concurrency\` real BACKGROUND tabs at once — full login session, full JS rendering, unlike batch_crawl — works through each, and saves each page's result as its own docs block as they finish. These tabs never steal window focus and won't become the default target for a browser_act/browser_inspect call that omits tabId. Returns almost immediately with a jobId; poll task_status — do NOT block waiting for this to "complete". Prefer this over several sequential browser_session(navigate)+browser_inspect(reading_mode) calls. Max ${MAX_JOB_TASKS} tasks per job, ${MAX_CONCURRENT_JOBS} jobs at once.
- task_status: check progress on an async task — a jobId from start_job OR a crawlId from deep_crawl, told apart automatically. Each call only returns results that finished since the LAST time you checked THIS id — already-reported results are never repeated, so it's cheap to poll repeatedly. A completed task is dropped from tracking the moment you've seen its last result; calling again after that returns "unknown".`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(BulkAction) },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to crawl concurrently, max 100 per call (action: 'batch_crawl').",
        },
        concurrency: {
          type: "number",
          description:
            "Parallel workers. Defaults scale with this machine's CPU core count — set explicitly only if you need a specific number (action: 'batch_crawl'/'deep_crawl'/'start_job', different caps per action).",
        },
        maxCharsPerUrl: {
          type: "number",
          description: "Cap on characters extracted per URL, default 15000 (action: 'batch_crawl'/'deep_crawl').",
        },
        query: { type: "string", description: "(action: 'search')" },
        limit: { type: "number", description: "Max results, default 10, max 30 (action: 'search')." },
        seedUrls: {
          type: "array",
          items: { type: "string" },
          description: "Root URLs to start from — provide this, searchQuery, or both (action: 'deep_crawl').",
        },
        searchQuery: {
          type: "string",
          description: "Run a search first and use its results as additional depth-0 roots (action: 'deep_crawl').",
        },
        depth: {
          type: "number",
          description: `How many hops of outbound links to follow, default 2, max ${MAX_CRAWL_DEPTH}. Depth 1 = just the seeds/search results, no following (action: 'deep_crawl').`,
        },
        maxPages: {
          type: "number",
          description: `Total page budget for the crawl, default 60, max ${MAX_CRAWL_PAGES} (action: 'deep_crawl').`,
        },
        maxOutlinksPerPage: {
          type: "number",
          description:
            "Cap on outbound links ONE page can add to the frontier, default 15, max 50 (action: 'deep_crawl').",
        },
        tasks: {
          type: "array",
          description: `1-${MAX_JOB_TASKS} pages to process concurrently (action: 'start_job').`,
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              extract: {
                type: "string",
                enum: ["reading_mode", "select_content", "snapshot"],
                description:
                  "What to do on each page once loaded — 'reading_mode' (default): clean article text. 'select_content': markdown from a selector (pass `selector` too). 'snapshot': the interactive-element list.",
              },
              selector: { type: "string", description: "CSS selector — only used when extract is 'select_content'." },
            },
            required: ["url"],
          },
        },
        taskId: {
          type: "string",
          description: "(action: 'task_status') A jobId or crawlId from start_job/deep_crawl.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: Gateway.Knowledge,
    description: `Durable, reusable knowledge saved across sessions — per-site skills, saved flows, and extracted docs blocks. Set \`action\` to one of: list_skills, save_skill, list_flows, save_flow, delete_flow, query_docs.

- list_skills: metadata only (name/domains/description, never full content) for saved skills — durable notes on how to work with a specific site (working selectors, role/name pairs, flow sequences). Check this before save_skill (update an existing one instead of duplicating), or when the user references a skill by name. browser_session's navigate action auto-surfaces a matching skill via skillHint, so you don't usually need to call this just to check the current page. Pass \`domain\` (exact hostname) or \`query\` (substring) once you have more than a handful saved.
- save_skill: create or update a skill — persist REUSABLE interaction knowledge (working selectors, role/name pairs, a flow sequence, gotchas) so a future session doesn't re-discover it from scratch. Do NOT call this just because you navigated somewhere or read a page. \`name\` is a lowercase slug; \`domains\` is required when creating a new skill, omit only when updating one that already has domains set. Always overwrites the full file — pass the complete content, not a diff. If a new skill's domains overlap an existing one, the response carries a \`_duplicateWarning\`.
- list_flows: metadata only (id, name, description, domain, step count) for saved flows. Use before save_flow to check whether a similar flow already exists, or to find a flow's id.
- save_flow: persist a step sequence (same shape as browser_act's run_flow \`steps\`) as a named, reusable flow — shows up with a Run button in the extension's side panel. Validate the sequence first (this does not run the steps, only stores them). Pass an existing flow's \`id\` to overwrite it instead of creating a near-duplicate; omit to create a new one. Rejected if any step needs a target (everything except scroll/drag/a target-less press_key) but has neither a selector nor a complete role+name pair — that step would never resolve at run time, so this is caught at save time instead of failing confusingly whenever the flow is finally run.
- delete_flow: remove a saved flow by \`id\` (from list_flows) — cleans it out of storage and the side panel. Use for a flow that turned out broken instead of leaving it cluttering the panel; a human can also delete it directly from the panel.
- query_docs: query content saved by select_content/batch_crawl/deep_crawl/start_job. Its own sub-action goes in \`docsAction\` (list/search/read — a separate field from this gateway's own \`action\`, which is always "query_docs" here): 'list' — cheap metadata only (id, source, title, char count); 'read' — full content of ONE block by \`blockId\`; 'search' — full-text search across blocks, returning a highlighted snippet per match, not full content. Defaults to the CURRENT session's blocks only; pass \`allSessions:true\` to search/list across every session ever recorded.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(KnowledgeAction) },
        domain: {
          type: "string",
          description:
            "Exact hostname filter (action: 'list_skills'/'list_flows'), or the hostname this flow targets, e.g. \"github.com\" — shown as a badge in the side panel (action: 'save_flow').",
        },
        query: {
          type: "string",
          description: "Substring match against name/description/domains (action: 'list_skills').",
        },
        name: { type: "string", description: "(action: 'save_skill'/'save_flow')" },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Required when creating a new skill (action: 'save_skill').",
        },
        description: { type: "string", description: "(action: 'save_skill'/'save_flow')" },
        content: { type: "string", description: "(action: 'save_skill')" },
        id: {
          type: "string",
          description:
            "Existing flow id to overwrite, omit to create a new one (action: 'save_flow'); the flow to remove (action: 'delete_flow', required — get it from list_flows).",
        },
        steps: {
          type: "array",
          items: FLOW_STEP_ITEM_SCHEMA,
          description: "(action: 'save_flow') Same shape as browser_act's run_flow steps.",
        },
        docsAction: {
          type: "string",
          enum: Object.values(DocsAction),
          description: "Required for action: 'query_docs' — which docs-query operation to run.",
        },
        blockId: {
          type: "number",
          description: "Required for docsAction:'read' — id from a prior 'list' or 'search' result.",
        },
        allSessions: {
          type: "boolean",
          description:
            "For docsAction 'list'/'search': include every session's blocks, not just the current one. Default false.",
        },
        limit: { type: "number", description: "Max results for docsAction 'list'/'search', default 20/50." },
      },
      required: ["action"],
    },
  },
  {
    name: Gateway.Dev,
    description: `Deep DevTools diagnostics, performance profiling, memory/RAM analytics, HAR export, UI/layout debugging, device emulation, and self-benchmarking. Follows Progressive Disclosure: returns a compact high-level summary (~20-40 tokens) by default; use \`focus\` to drill down into specific bottlenecks. Set \`action\` to one of: inspect_memory, inspect_process, analyze_har, export_har, debug_layout, emulate, sandbox, benchmark_report.

- inspect_memory: measure JS Heap usage (used/total MB), active DOM nodes, documents, and event listeners. Detects GC pressure and potential memory leaks. Set \`focus:'dom'\` for top container element counts, \`focus:'listeners'\` for event listener analysis, or \`focus:'gc'\` to trigger V8 garbage collection.
- inspect_process: analyze CPU execution time, breakdown of ScriptDuration, LayoutDuration (reflows), and RecalcStyleDuration. Identifies whether performance is CPU/Script-bound or Layout-bound. Set \`focus:'long_tasks'\` for blocking Long Tasks (>50ms).
- analyze_har: analyze network traffic summary (total requests, transfer size, failed API calls, slowest request duration) without dumping raw headers into context. Set \`filter\` to scope by URL substring.
- export_har: generate and save a standard W3C HAR 1.2 file to disk (data/har/session-*.har) containing complete network logs (requests, responses, timings) that can be directly imported into Chrome DevTools Network Tab or Wireshark.
- debug_layout: deep inspection of Box Model (margin/border/padding quads), Computed CSS, Stacking Context creation (z-index, opacity, transform, isolation), and viewport visibility for a specific element (pass \`selector\` or \`nodeId\`). Set \`focus:'computed'\` or \`focus:'box_model'\` for deep styling details.
- emulate: simulate device viewports (iphone14, pixel7, ipad, desktop), touch emulation, network throttling (offline, slow_3g, fast_3g, none), and CPU slowdown (2x, 4x, 6x).
- sandbox: set \`mode:'block_mutations'\` to intercept every POST/PUT/PATCH/DELETE this tab fires — nothing reaches the real server. Answered with a real response this endpoint already produced this session if one was recorded, otherwise the submitted body echoed back. GET/HEAD still pass through untouched. Use this before exploring an unfamiliar UI so an accidental click on Save/Delete/Submit can't actually mutate real data; \`inspect.network_requests\` marks anything intercepted with \`blocked:true\`. Set \`mode:'off'\` to restore normal behavior once you're done exploring or the user asks for the real action to go through.
- benchmark_report: generate a comprehensive self-benchmark report for the current session (or specified \`sessionId\`), analyzing token economics, savings breakdown, and runtime memory stability / leak detection.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.values(DevAction) },
        sessionId: {
          type: "string",
          description: "Optional session id for action: 'benchmark_report' (defaults to active session).",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format for action: 'benchmark_report' (default 'markdown').",
        },
        focus: {
          type: "string",
          description:
            "Drill down target for progressive disclosure: 'overview' (default), 'dom', 'listeners', 'gc' (for inspect_memory); 'long_tasks', 'rendering' (for inspect_process); 'box_model', 'computed', 'stacking' (for debug_layout); 'telemetry', 'commands', 'full' (for benchmark_report).",
        },
        selector: { type: "string", description: "CSS selector of element to inspect (action: 'debug_layout')." },
        nodeId: { type: "number", description: "Node id from snapshot to inspect (action: 'debug_layout')." },
        filter: {
          type: "string",
          description: "URL substring filter for network analysis (action: 'analyze_har'/'export_har').",
        },
        includeBodies: {
          type: "boolean",
          description: "Include response bodies in HAR export, default false (action: 'export_har').",
        },
        device: {
          type: "string",
          enum: ["iphone14", "pixel7", "ipad", "desktop"],
          description: "Emulate device screen metrics & touch (action: 'emulate').",
        },
        network: {
          type: "string",
          enum: ["offline", "slow_3g", "fast_3g", "none"],
          description: "Emulate network speed & latency (action: 'emulate').",
        },
        cpuSlowdown: {
          type: "number",
          description: "CPU throttling slowdown factor, e.g. 2, 4, 6 (action: 'emulate').",
        },
        touch: { type: "boolean", description: "Enable touch event emulation (action: 'emulate')." },
        mode: {
          type: "string",
          enum: ["block_mutations", "off"],
          description:
            "Required for action: 'sandbox'. 'block_mutations' intercepts POST/PUT/PATCH/DELETE on this tab and mocks the response instead of sending it; 'off' restores normal behavior.",
        },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
] as const;

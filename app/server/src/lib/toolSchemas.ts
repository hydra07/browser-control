// MCP tool surface: 5 gateway tools instead of one per action (32 of them
// at last count — browser_click, browser_navigate, browser_snapshot, ...).
// Each takes `action` (which of that gateway's actions to run) plus that
// action's own params, flattened into one property bag per gateway. Same
// "one param bag, `action`-tagged description per field" shape
// FLOW_STEP_ITEM_SCHEMA already used for run_flow's steps, one level up.
//
// Grouped by response shape, not alphabetically — act (sync DOM actions),
// inspect (sync reads), session (tab/recording lifecycle), bulk (async,
// id+poll), knowledge (persisted-state CRUD) — so mixing e.g. a sync click
// with an async start_job in the same gateway never makes "what does this
// call return" unpredictable.
//
// Pure data — no server/WebSocket state — so this stays importable from
// anywhere without pulling in daemon.ts.

import { MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, MAX_CONCURRENT_CRAWLS } from "./crawl.js";
import { MAX_JOB_TASKS, MAX_CONCURRENT_JOBS } from "./jobs.js";

/** Spread into every tab-scoped action's property bag. */
export const TAB_ID_PROPERTY = {
  tabId: { type: "number", description: "Target this specific tab (id from session.navigate's response or session.list_tabs) instead of the currently active one. Omit to use the current tab, same as always." },
} as const;

/** Shared by browser_act's run_flow and browser_knowledge's save_flow — a saved flow is the exact FlowStep[] shape run_flow runs. Each step's own `action` enum is nested inside the array, unrelated to (and not colliding with) a gateway's top-level `action`. */
export const FLOW_STEP_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "type", "press_key", "wait_for", "assert_text", "scroll", "drag"] },
    role: { type: "string", description: "Accessibility role of the target, from a prior inspect.snapshot (e.g. 'button', 'textbox')." },
    name: { type: "string", description: "Accessible name of the target, paired with role." },
    selector: { type: "string", description: "CSS selector, as an alternative to role+name." },
    text: { type: "string", description: "Text to type (action: 'type')." },
    key: { type: "string", description: "Key to press (action: 'press_key') — a named key or a single character, see act.press_key." },
    contains: { type: "string", description: "Substring the target's accessible name must contain (action: 'assert_text')." },
    deltaX: { type: "number", description: "Scroll delta (action: 'scroll')." },
    deltaY: { type: "number", description: "Scroll delta (action: 'scroll')." },
    fromX: { type: "number", description: "Drag start x, viewport pixels (action: 'drag')." },
    fromY: { type: "number", description: "Drag start y, viewport pixels (action: 'drag')." },
    toX: { type: "number", description: "Drag end x, viewport pixels (action: 'drag')." },
    shape: { type: "string", enum: ["straight", "circle", "arc", "ellipse", "bezier", "sine", "zigzag", "spiral", "waypoints", "polygon", "star", "heart", "flower", "rectangle", "box", "parametric", "polar", "function"], description: "Geometric or mathematical function trajectory shape (action: 'drag')." },
    shapeParams: { type: "object", description: "Parameters for shape drag: math formulas {fnX, fnY, fnR, tMin, tMax}, center {cx, cy}, radius {radius, radiusX, radiusY}, angles {startAngle, endAngle}, or presets {petals, numPoints, outerRadius, innerRadius, size, width, height}." },
    path: { type: "array", description: "Array of [x, y] or {x, y} coordinate waypoints for path dragging (action: 'drag')." },
    stepsCount: { type: "number", description: "Number of intermediate interpolation steps for drag." },
    easing: { type: "string", enum: ["linear", "easeIn", "easeOut", "easeInOut"], description: "Easing function for drag movement." },
    button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for drag (default 'left')." },
    timeoutMs: { type: "number", description: "Max time in ms to poll for the target to appear (action: 'wait_for'), default 3000." },
    confirmRisky: { type: "boolean", description: "Set true to proceed past a step whose target looks destructive/irreversible (delete, cancel, sign out, pay, confirm, ...) — only after confirming with your user that this step is intended." },
  },
  required: ["action"],
} as const;

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

Dual-Mode & Progressive Disclosure Principle:
- Agent Execution Mode (Default): Optimize aggressively for tokens. Always receive clean, compact high-level overviews first (~20-40 tokens). When a specific problem is identified, use \`focus\` / \`detail\` parameters to drill down into that specific element/request without dumping giant JSON trees into context.
- End-User / Tool UI Mode: When user requests full diagnostics or exports, provide maximum fidelity (HAR 1.2 file exports, full visual snapshots, and Sidepanel Benchmark/DevTools integration).
  Use plain act.run_flow (returnSnapshot defaults to false), use
  inspect.snapshot({compact:true}) or inspect.find for element location,
  and use inspect.select_content / bulk.batch_crawl for data extraction.
  Call session.get_metrics anytime to inspect token usage & savings.
- End-User / Tool UI Mode: When user requests full visual inspect, UI
  debugging, or panel interaction, provide maximum fidelity (visual:true,
  inspect_element, returnSnapshot:true, or open the Sidepanel Benchmark tab).

BrowserControl drives real Chrome tabs (grouped as "🤖 AI Workspace") via
your everyday browser's debugger, not a headless/isolated instance. Every
action defaults to whichever tab session.navigate/session.switch_tab last
pointed at — for a single-tab session, that's all you need, same as ever.
To work with more than one tab at once (compare two pages, fill a form on
one while watching another, anything genuinely parallel), pass tabId
(returned by session.navigate, or from session.list_tabs) on any act/
inspect action to target that specific tab regardless of which one is
"current" — no switch_tab round trip needed between steps on different
tabs. Open an additional tab without disturbing the current one via
session.navigate({url, newTab: true}); its response's tabId is what you
capture and reuse. Each tab keeps its own CDP session (attaching one
doesn't detach another), but note two things stay scoped to a single
tab regardless: session.start_recording/session.stop_recording, and the
network log (inspect.network_requests/inspect.network_clear).

When the work is "go read/extract N pages" rather than one interactive
flow, don't drive that yourself with N sequential session.navigate calls.
For public, mostly-static content (docs, articles, wikis) at real volume,
use bulk.batch_crawl (or bulk.deep_crawl to also follow the links each
page turns up, to a depth you set) — these fetch directly, no tab
overhead, so they scale to dozens of pages. For pages needing an actual
login session or client-rendered content, use bulk.start_job instead —
same idea, real tabs. bulk.search gets you clean {title,url} results to
feed any of these instead of navigating to a search engine and parsing the
results page yourself. All three of the async ones (bulk.start_job,
bulk.deep_crawl) return an id almost immediately and keep working in
the background — poll bulk.task_status(taskId) for progress; each poll
only returns what finished since your LAST check on that id, never
repeating a result, which is also why it's cheap to poll repeatedly
instead of trying to time it perfectly.

Whatever inspect.select_content/bulk.batch_crawl/bulk.deep_crawl/
bulk.start_job extract is saved as individual docs blocks (SQLite-backed,
NOT one growing file you read with offset/limit) — each returns the new
block id(s), and knowledge.query_docs is how you read one back
({docsAction:"read", blockId}) or find the right one across everything
saved this session, or every session ever recorded with allSessions:true
({docsAction:"search", query}). If you did something on a session worth
being able to find again later, session.set_session_name({name}) labels
it — not required, sessions auto-name from the hostnames they visited,
but a real description is more useful than a hostname list.

"🤖 AI Workspace" is a two-way handoff, not just where the tabs you open
end up: the user can drag a tab they already have open into that group
themselves, and session.list_tabs is how you find out — it's the only
notification channel, since there's no way for anything to interrupt you
mid-turn. Call it at the start of a session and whenever the user
references a tab they already have open ("check this", "I put a page
there"); entries with isNew:true are ones added since you last checked.
Use session.switch_tab on the result to start working on it directly.

If a tool call returns "Unknown command: <name>" with a hint about a
version mismatch: this means the Chrome extension loaded in the browser is
an older build than this daemon (MV3 extensions never pick up source
changes automatically — reloading in chrome://extensions is required after
any browsercontrol update). Tell the user to reload the extension and retry.
Do NOT work around this by installing Playwright, Puppeteer, Selenium, or
writing your own screenshot script — you do not have a capability gap, you
have a stale extension, and installing other automation tooling will not
fix that and may not even be permitted in your environment.

Workflow for interacting with a page:
1. session.navigate to the target URL. If the response includes a
   skillHint field, a skill already exists for this domain — read that file
   before doing any exploratory work; it may already have the selectors/
   flow you're about to spend calls rediscovering. No hint doesn't mean no
   skill could ever exist here — check knowledge.list_skills if you're not
   sure, or if the user mentions a skill by name.
2. inspect.snapshot for a fast text list of interactive elements (id, role,
   name, value). If you're not fully confident which id is the right one
   (custom dropdowns, icon-only buttons, repeated labels), use
   inspect.snapshot({visual:true}) instead — it draws a numbered box over
   every interactive element on a screenshot, so you can ground the id to a
   position before clicking.
3. act.click / act.type using the id from the snapshot. These dispatch
   real, trusted input events (same as a physical mouse/keyboard), so they
   exercise the actual event handlers a user would trigger.
4. act.type only inserts text — it never submits anything on its own. To
   submit a search box or form, or navigate a custom dropdown, follow it
   with act.press_key (Enter, Tab, Escape, arrows, ...).
5. Prefer batching ALL sequential actions into act.run_flow: If you need
   to perform more than 1 action (e.g. type then press Enter, multiple
   navigation keys, drag sequences, scrolling, filling a form), NEVER call
   act.click / act.type / act.press_key / act.drag / act.scroll one by one in
   a loop. Pack them all into one act.run_flow call. This turns 5-10
   slow roundtrips into 1 single fast execution.
6. For a multi-step flow (login, form fill, search, navigation), don't
   drive it one call at a time — write the whole sequence as steps
   referencing elements by role+name (from the snapshot) or CSS selector
   and send it in one act.run_flow call. Default to plain act.run_flow, not
   explore:true — explore:true is for validating ONE uncertain sequence
   against an unfamiliar UI, not a general substitute for a plain run.
   Repeatedly running with explore:true instead of switching to plain once
   you already know the flow works is the single biggest token cost this
   tool has measured in practice — on a real multi-scenario test session,
   10 explore:true calls alone accounted for over 75% of the session's
   total tool-call tokens, some individual calls running into the tens of
   thousands of tokens against a data-heavy page. If most of your
   act.run_flow calls in a session have explore:true set, you are almost
   certainly using it wrong — switch to plain. Both modes stop at the first
   step that doesn't resolve or fails, so a flow that goes wrong is never
   worse than the step-by-step equivalent.
7. Once you've worked out how a site behaves (selectors, role/name pairs, a
   working flow sequence), save it with knowledge.save_skill so a future
   session doesn't pay the same discovery cost again — this is the whole
   point of splitting explore:true (discovery) from a plain run (cheap
   reuse). Check knowledge.list_skills first: update
   an existing skill for this domain rather than creating a near-duplicate.
   You don't need to do this for a one-off task on a site you'll never
   revisit — it's for anything you can reasonably expect to come back to.

Action selection within browser_act/browser_inspect — this is important
for anything you intend to report as a verified UI behavior:
- act.click / act.type / act.press_key / act.run_flow: the ONLY actions
  that count as testing real user
  interaction. Prefer them whenever you're checking that a button, link, or
  form field actually works. Standalone click/type/press_key glide a
  visible cursor dot to the target and briefly outline it (violet for
  click, cyan for type/key) — a multi-step animation (glide, pause, press,
  ripple) that takes a couple of seconds per action — so a human watching
  the tab can actually follow what's happening instead of it jumping
  instantly between fields. This adds real latency; it's intentional, not a
  bug. Flow steps use a faster, lighter version of the same animation so a
  multi-step script doesn't take unreasonably long. act.evaluate does
  none of this.
- act.evaluate: for reading state (localStorage, computed values) or
  test setup/teardown (e.g. seeding an auth token). Do NOT use it to click
  buttons or fill fields as a shortcut — setting element.value via JS does
  not reliably trigger React/Vue's onChange, so a broken input can look
  like it works when it doesn't. If you used evaluate to fill a form, say
  so explicitly rather than reporting it as a tested interaction.
- inspect.screenshot: pure visual inspection (layout, spacing, colors) when
  you need to see rendering issues the accessibility tree can't show.
- inspect.snapshot({visual:true}): structure + visual grounding in one
  call, for when you need both an id to act on and confidence about its
  position.
- session.start_recording / session.stop_recording: when what matters is
  motion, not a single frame — a drag, an animation, a multi-step wizard you
  want to hand back as one video instead of a pile of screenshots. Bracket
  just the part you actually need recorded; don't leave a recording running
  across unrelated exploration.
- inspect.inspect_element: inspect.snapshot deliberately shows very little
  per element to stay cheap across a whole page. When you need to know WHY
  one specific element looks or behaves a certain way — which CSS rule set
  that color/spacing, what its computed layout is, whether it has a click/
  change listener attached — call inspect.inspect_element on its id instead
  of trying to infer it from the snapshot or re-reading source files blind.
- inspect.snapshot({selector:...}): the middle tier between a plain
  inspect.snapshot (whole page, flat, cheap, but a form field's label can be
  50 unrelated elements away in the list) and inspect.inspect_element (one
  element, no surrounding context). Pass a CSS selector for the containing
  form/panel/row and get back a nested tree of just what's inside it — a
  label and its field are siblings in the same "children" array, so the
  association is structural, not something you infer from ordering. Prefer
  this over a plain inspect.snapshot when you're specifically trying to fill
  out or verify one form/section, and especially when inspect.snapshot
  showed you fields with an empty name (no accessible label) that you need
  to correctly associate.
- inspect.reading_mode: when the goal is reading content (an article, docs
  page, blog post), not acting on it — returns clean title+body text with
  the accessibility tree skipped entirely, cheaper than inspect.snapshot for
  that specific job. Says so and returns nothing useful on non-article pages
  (an app UI, a dashboard) — fall back to inspect.snapshot there.
- inspect.find: when you already know what you're looking for (a label, an
  error message, a specific price) on a large page — jumps straight to
  matching elements (by text, CSS selector, or XPath) instead of you
  scanning a full inspect.snapshot node list. Returns the same {i,r,n}
  shape as inspect.snapshot, usable directly with act.click/act.type.

Both inspect.screenshot and inspect.snapshot({visual:true}) save the image
to a file on disk and give you the path in the text output. Inline image
content is OFF by default (set BROWSERCONTROL_INLINE_IMAGES=true to enable)
because some MCP clients — notably some Antigravity CLI versions — can't
handle image content from MCP servers, and a mishandled screenshot risks
landing in your context as raw base64 text: a single ~700KB PNG is roughly
230k tokens that way. This is not hypothetical — it has burned a large
chunk of a 5-hour usage window in practice. Concretely:
- Never pass format:"png" unless you specifically need pixel-exact color
  values — it is 3-5x larger than the jpeg default for no benefit in
  routine "let me see the page" checks.
- Don't call inspect.screenshot / inspect.snapshot({visual:true}) on every
  step. Use inspect.snapshot (cheap, text-only) as your default; reach for
  a screenshot only when you actually need to visually confirm layout/
  styling or ground an ambiguous click target.
- If your client doesn't render inline images, read the saved file path
  rather than re-requesting the screenshot hoping it renders differently.

Inspecting the network call behind a submit/action button (like the DevTools
Network tab):
1. inspect.network_clear right before the click, so old page-load requests
   don't drown out the one you care about.
2. act.click the submit/action button.
3. inspect.network_requests to see what fired — defaults to XHR/Fetch/
   Document/WebSocket only (the actual API calls), not static assets.
4. inspect.network_requests again with requestId set (from that list) if
   you need the full request/response headers or body (e.g. to check the
   payload sent or the error message returned).
The network log also auto-clears on every session.navigate.

act.run_flow (either mode) blocks a step by default if its target's
accessible name looks destructive/irreversible (delete, remove, cancel, sign
out, pay, confirm, ...) — the response will have reason:"risky_action_blocked"
and a message naming the step. This tool has no way to ask your user directly,
so that's your job: surface the blocked step to your user, and only re-run
with that step's confirmRisky:true once they've confirmed it's intended.
Don't set confirmRisky:true reflexively just to get the flow to complete.

Once an act.run_flow sequence is validated and working, knowledge.save_flow
persists it (name + the same steps array) as a reusable flow — it then shows
up with a Run button in the extension's side panel, so a human can re-run it
without you. Save one when you've worked out something worth re-running
later (a login flow, a recurring form), not for a one-off sequence you'll
never use again. Check knowledge.list_flows first and pass that flow's id
back to knowledge.save_flow to update it instead of creating a near-duplicate.

If a command times out or errors, check the returned "hint" field before
retrying blindly — it usually points at the actual cause (stale node id,
extension not connected, unhandled dialog, etc).
`.trim();

export const TOOLS = [
  {
    name: "browser_act",
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
        action: { type: "string", enum: ["click", "type", "press_key", "scroll", "drag", "evaluate", "run_flow"] },
        nodeId: { type: "number", description: "Element to act on (click), or to focus first (type/press_key — omit only if already focused)." },
        text: { type: "string", description: "Text to type (action: 'type')." },
        key: { type: "string", description: "Key to press (action: 'press_key')." },
        deltaX: { type: "number", description: "Scroll delta (action: 'scroll')." },
        deltaY: { type: "number", description: "Scroll delta (action: 'scroll')." },
        fromX: { type: "number", description: "Drag start x, viewport pixels (action: 'drag')." },
        fromY: { type: "number", description: "Drag start y, viewport pixels (action: 'drag')." },
        toX: { type: "number", description: "Drag end x, viewport pixels (action: 'drag')." },
        toY: { type: "number", description: "Drag end y, viewport pixels (action: 'drag')." },
        shape: { type: "string", enum: ["straight", "circle", "arc", "ellipse", "bezier", "sine", "zigzag", "spiral", "waypoints", "polygon", "star", "heart", "flower", "rectangle", "box", "parametric", "polar", "function"], description: "Geometric or mathematical function trajectory shape (action: 'drag')." },
        shapeParams: { type: "object", description: "Parameters for shape drag: math formulas {fnX, fnY, fnR, tMin, tMax}, center {cx, cy}, radius {radius, radiusX, radiusY}, angles {startAngle, endAngle}, or presets {petals, numPoints, outerRadius, innerRadius, size, width, height}." },
        path: { type: "array", description: "Array of [x, y] or {x, y} coordinate waypoints for path dragging (action: 'drag')." },
        stepsCount: { type: "number", description: "Number of intermediate interpolation steps for drag." },
        easing: { type: "string", enum: ["linear", "easeIn", "easeOut", "easeInOut"], description: "Easing function for drag movement." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for drag (default 'left')." },
        expression: { type: "string", description: "JavaScript to evaluate (action: 'evaluate')." },
        steps: { type: "array", description: "Ordered list of steps (action: 'run_flow'). Stops at the first step that doesn't resolve or fails.", items: FLOW_STEP_ITEM_SCHEMA },
        explore: { type: "boolean", description: "(action: 'run_flow') Add a per-step delta to validate an unfamiliar/best-guess sequence once, instead of a plain run. Don't default to this once a flow is validated — see the tool description." },
        returnSnapshot: { type: "boolean", description: "(action: 'run_flow') Set true to return full final accessibility snapshot after completing the flow. Defaults to false to conserve tokens." },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
  {
    name: "browser_inspect",
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
        action: { type: "string", enum: ["snapshot", "find", "reading_mode", "inspect_element", "screenshot", "select_content", "network_requests", "network_clear", "peek_screen"] },
        compact: { type: "boolean", description: "(action: 'snapshot') Return dense 1-line-per-node text format instead of multi-line JSON, saving ~75% tokens. Recommended for large DOMs." },
        visual: { type: "boolean", description: "(action: 'snapshot') Also return an annotated screenshot with numbered boxes over interactive elements." },
        selector: { type: "string", description: "CSS selector — scopes into a nested tree (action: 'snapshot'), or the elements to extract (action: 'select_content')." },
        query: { type: "string", description: "Text, CSS selector, or XPath to search for (action: 'find')." },
        limit: { type: "number", description: "Max matches to return, default 20 (action: 'find')." },
        nodeId: { type: "number", description: "Element id, from a prior snapshot/find (action: 'inspect_element' or 'select_content')." },
        maxChars: { type: "number", description: "Cap on returned/extracted text length (action: 'reading_mode', default 20000; or 'select_content', default 20000 per call; or 'peek_screen', default 15000)." },
        maxMatches: { type: "number", description: "Max elements to extract when using selector, default 20 (action: 'select_content')." },
        fullPage: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport (action: 'screenshot')." },
        format: { type: "string", enum: ["jpeg", "png"], description: "(action: 'screenshot') Leave unset (defaults to jpeg) — see the tool description for why png is almost never worth it." },
        quality: { type: "number", description: "JPEG quality 0-100, default 80 (action: 'screenshot')." },
        screenshot: { type: "boolean", description: "(action: 'peek_screen') Also capture visual JPEG screenshot of the active screen for multimodal vision inspection." },
        resourceTypes: { type: "array", items: { type: "string" }, description: "(action: 'network_requests') CDP resource type names (XHR, Fetch, Document, Script, Stylesheet, Image, Font, Media, WebSocket, ...). Overrides the default filter." },
        filter: { type: "string", description: "(action: 'network_requests') Only include requests whose URL contains this substring." },
        requestId: { type: "string", description: "(action: 'network_requests') Get full detail for this one request instead of listing." },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
  {
    name: "browser_session",
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
        action: { type: "string", enum: ["navigate", "list_tabs", "switch_tab", "close_tab", "set_session_name", "start_recording", "stop_recording", "get_metrics"] },
        url: { type: "string", description: "(action: 'navigate')" },
        newTab: { type: "boolean", description: "Open in a new tab instead of reusing the current one (action: 'navigate'). Ignored if tabId is set." },
        tabId: { type: "number", description: "Target tab. For 'navigate': re-navigate this specific existing tab instead of the current/a new one. For 'switch_tab'/'close_tab': the tab to act on (required)." },
        name: { type: "string", description: "(action: 'set_session_name')" },
        scope: { type: "string", enum: ["workspace", "all"], description: "(action: 'list_tabs') 'workspace' (default) lists only AI Workspace tabs; 'all' lists all open tabs across the browser." },
        allSessions: { type: "boolean", description: "(action: 'get_metrics') Include metrics across all sessions instead of just current session." },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_bulk",
    description: `Async/bulk multi-page work — the async actions return an id almost immediately and keep working in the background; poll with action:'task_status'. Set \`action\` to one of: batch_crawl, search, deep_crawl, start_job, task_status.

- batch_crawl: concurrent \`fetch()\`-based crawler for heavy workloads — fetch and extract clean Markdown from multiple URLs (\`urls\`, max 100/call) in parallel without opening visible tabs. Automatically extracts metadata (Title, Author, Published Date, Reading Time) and outbound links, applies Readability heuristics, dedupes against every URL already crawled this session, and saves each page as its own docs block. Returns a compact execution summary and the new block ids, never the extracted content itself. Unlike every other action here, this does NOT go through a real browser tab — no cookies/login session, no JavaScript. Only use for public, mostly-static pages (docs, blog posts, wikis) — it silently returns thin/empty results on a login-gated or JS-rendered page, not an error. For recursively following the links a crawl turns up, use deep_crawl instead of calling this in a loop.
- search: run a web search and get back clean {title, url, snippet} results — feed into batch_crawl/start_job/deep_crawl instead of navigating to a search engine and parsing the results page yourself. Same fetch()-based mechanism as batch_crawl (no login session, no JS) via DuckDuckGo's HTML endpoint.
- deep_crawl: recursive crawl — start from \`seedUrls\` and/or a \`searchQuery\`, follow the outbound links pages turn up, up to \`depth\` hops deep, automatically. A continuous pool of \`concurrency\` workers drains a shared queue (a real frontier, not depth-by-depth batches). Built on the same per-page fetch as batch_crawl (same no-login caveat). Returns a crawlId almost immediately; poll task_status — each call only reports pages that finished since your last check. Each page saved as its own docs block as it finishes; this never returns crawled content directly. Max ${MAX_CRAWL_DEPTH} depth, max ${MAX_CRAWL_PAGES} total pages, ${MAX_CONCURRENT_CRAWLS} crawls running at once.
- start_job: async multi-tab task runner: give it a list of URLs (\`tasks\`, each with what to extract), it opens up to \`concurrency\` real BACKGROUND tabs at once — full login session, full JS rendering, unlike batch_crawl — works through each, and saves each page's result as its own docs block as they finish. These tabs never steal window focus and won't become the default target for a browser_act/browser_inspect call that omits tabId. Returns almost immediately with a jobId; poll task_status — do NOT block waiting for this to "complete". Prefer this over several sequential browser_session(navigate)+browser_inspect(reading_mode) calls. Max ${MAX_JOB_TASKS} tasks per job, ${MAX_CONCURRENT_JOBS} jobs at once.
- task_status: check progress on an async task — a jobId from start_job OR a crawlId from deep_crawl, told apart automatically. Each call only returns results that finished since the LAST time you checked THIS id — already-reported results are never repeated, so it's cheap to poll repeatedly. A completed task is dropped from tracking the moment you've seen its last result; calling again after that returns "unknown".`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["batch_crawl", "search", "deep_crawl", "start_job", "task_status"] },
        urls: { type: "array", items: { type: "string" }, description: "URLs to crawl concurrently, max 100 per call (action: 'batch_crawl')." },
        concurrency: { type: "number", description: "Parallel workers. Defaults scale with this machine's CPU core count — set explicitly only if you need a specific number (action: 'batch_crawl'/'deep_crawl'/'start_job', different caps per action)." },
        maxCharsPerUrl: { type: "number", description: "Cap on characters extracted per URL, default 15000 (action: 'batch_crawl'/'deep_crawl')." },
        query: { type: "string", description: "(action: 'search')" },
        limit: { type: "number", description: "Max results, default 10, max 30 (action: 'search')." },
        seedUrls: { type: "array", items: { type: "string" }, description: "Root URLs to start from — provide this, searchQuery, or both (action: 'deep_crawl')." },
        searchQuery: { type: "string", description: "Run a search first and use its results as additional depth-0 roots (action: 'deep_crawl')." },
        depth: { type: "number", description: `How many hops of outbound links to follow, default 2, max ${MAX_CRAWL_DEPTH}. Depth 1 = just the seeds/search results, no following (action: 'deep_crawl').` },
        maxPages: { type: "number", description: `Total page budget for the crawl, default 60, max ${MAX_CRAWL_PAGES} (action: 'deep_crawl').` },
        maxOutlinksPerPage: { type: "number", description: "Cap on outbound links ONE page can add to the frontier, default 15, max 50 (action: 'deep_crawl')." },
        tasks: {
          type: "array",
          description: `1-${MAX_JOB_TASKS} pages to process concurrently (action: 'start_job').`,
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              extract: { type: "string", enum: ["reading_mode", "select_content", "snapshot"], description: "What to do on each page once loaded — 'reading_mode' (default): clean article text. 'select_content': markdown from a selector (pass `selector` too). 'snapshot': the interactive-element list." },
              selector: { type: "string", description: "CSS selector — only used when extract is 'select_content'." },
            },
            required: ["url"],
          },
        },
        taskId: { type: "string", description: "(action: 'task_status') A jobId or crawlId from start_job/deep_crawl." },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_knowledge",
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
        action: { type: "string", enum: ["list_skills", "save_skill", "list_flows", "save_flow", "delete_flow", "query_docs"] },
        domain: { type: "string", description: "Exact hostname filter (action: 'list_skills'/'list_flows'), or the hostname this flow targets, e.g. \"github.com\" — shown as a badge in the side panel (action: 'save_flow')." },
        query: { type: "string", description: "Substring match against name/description/domains (action: 'list_skills')." },
        name: { type: "string", description: "(action: 'save_skill'/'save_flow')" },
        domains: { type: "array", items: { type: "string" }, description: "Required when creating a new skill (action: 'save_skill')." },
        description: { type: "string", description: "(action: 'save_skill'/'save_flow')" },
        content: { type: "string", description: "(action: 'save_skill')" },
        id: { type: "string", description: "Existing flow id to overwrite, omit to create a new one (action: 'save_flow'); the flow to remove (action: 'delete_flow', required — get it from list_flows)." },
        steps: { type: "array", items: FLOW_STEP_ITEM_SCHEMA, description: "(action: 'save_flow') Same shape as browser_act's run_flow steps." },
        docsAction: { type: "string", enum: ["list", "search", "read"], description: "Required for action: 'query_docs' — which docs-query operation to run." },
        blockId: { type: "number", description: "Required for docsAction:'read' — id from a prior 'list' or 'search' result." },
        allSessions: { type: "boolean", description: "For docsAction 'list'/'search': include every session's blocks, not just the current one. Default false." },
        limit: { type: "number", description: "Max results for docsAction 'list'/'search', default 20/50." },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_dev",
    description: `Deep DevTools diagnostics, performance profiling, memory/RAM analytics, HAR export, UI/layout debugging, and device emulation. Follows Progressive Disclosure: returns a compact high-level summary (~20-40 tokens) by default; use \`focus\` to drill down into specific bottlenecks. Set \`action\` to one of: inspect_memory, inspect_process, analyze_har, export_har, debug_layout, emulate.

- inspect_memory: measure JS Heap usage (used/total MB), active DOM nodes, documents, and event listeners. Detects GC pressure and potential memory leaks. Set \`focus:'dom'\` for top container element counts, \`focus:'listeners'\` for event listener analysis, or \`focus:'gc'\` to trigger V8 garbage collection.
- inspect_process: analyze CPU execution time, breakdown of ScriptDuration, LayoutDuration (reflows), and RecalcStyleDuration. Identifies whether performance is CPU/Script-bound or Layout-bound. Set \`focus:'long_tasks'\` for blocking Long Tasks (>50ms).
- analyze_har: analyze network traffic summary (total requests, transfer size, failed API calls, slowest request duration) without dumping raw headers into context. Set \`filter\` to scope by URL substring.
- export_har: generate and save a standard W3C HAR 1.2 file to disk (data/har/session-*.har) containing complete network logs (requests, responses, timings) that can be directly imported into Chrome DevTools Network Tab or Wireshark.
- debug_layout: deep inspection of Box Model (margin/border/padding quads), Computed CSS, Stacking Context creation (z-index, opacity, transform, isolation), and viewport visibility for a specific element (pass \`selector\` or \`nodeId\`). Set \`focus:'computed'\` or \`focus:'box_model'\` for deep styling details.
- emulate: simulate device viewports (iphone14, pixel7, ipad, desktop), touch emulation, network throttling (offline, slow_3g, fast_3g, none), and CPU slowdown (2x, 4x, 6x).`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["inspect_memory", "inspect_process", "analyze_har", "export_har", "debug_layout", "emulate"] },
        focus: { type: "string", description: "Drill down target for progressive disclosure: 'overview' (default), 'dom', 'listeners', 'gc' (for inspect_memory); 'long_tasks', 'rendering' (for inspect_process); 'box_model', 'computed', 'stacking' (for debug_layout)." },
        selector: { type: "string", description: "CSS selector of element to inspect (action: 'debug_layout')." },
        nodeId: { type: "number", description: "Node id from snapshot to inspect (action: 'debug_layout')." },
        filter: { type: "string", description: "URL substring filter for network analysis (action: 'analyze_har'/'export_har')." },
        includeBodies: { type: "boolean", description: "Include response bodies in HAR export, default false (action: 'export_har')." },
        device: { type: "string", enum: ["iphone14", "pixel7", "ipad", "desktop"], description: "Emulate device screen metrics & touch (action: 'emulate')." },
        network: { type: "string", enum: ["offline", "slow_3g", "fast_3g", "none"], description: "Emulate network speed & latency (action: 'emulate')." },
        cpuSlowdown: { type: "number", description: "CPU throttling slowdown factor, e.g. 2, 4, 6 (action: 'emulate')." },
        touch: { type: "boolean", description: "Enable touch event emulation (action: 'emulate')." },
        ...TAB_ID_PROPERTY,
      },
      required: ["action"],
    },
  },
] as const;

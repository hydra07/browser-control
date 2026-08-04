import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { recordAndCheckFlow } from "./lib/sessionFlow.js";
import type { ExtensionResponse } from "../shared/protocol.js";

// The daemon never validates a tool's `arguments` against a schema beyond
// what the MCP SDK already does — logging/forwarding code just needs "some
// JSON-serializable object", not the exact shape, so `unknown` (not a typed
// union) is the honest type here.
type ToolArgs = Record<string, unknown> | undefined;
// executeCommand's return is whatever background.ts's dispatchCommand
// returned for that cmd (see the BrowserCommand-keyed branches in
// background.ts) — a different shape per command, so callers narrow with
// optional chaining rather than this being `any`.
type CommandResult = Record<string, unknown>;
type ToolCallResponse = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

// Redirect all console output to stderr to prevent corrupting MCP JSON-RPC over stdout
console.log = console.error;
console.info = console.error;

// Not all MCP clients render inline image content blocks — some Antigravity
// CLI versions can't handle images from MCP servers at all, and when they
// can't, the base64 payload risks being dumped into the model's context as
// raw text instead of being discarded (a single ~700KB PNG is ~230k tokens
// that way). Default to file-only; set BROWSERCONTROL_INLINE_IMAGES=true for
// clients (e.g. Claude Code) known to handle image content blocks properly.
const INLINE_IMAGES = process.env.BROWSERCONTROL_INLINE_IMAGES === "true";

const SCREENSHOTS_DIR = join(import.meta.dir, "..", "..", "screenshots");
try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

function saveScreenshotToFile(dataBase64: string, format: string): string {
  const ext = format === "png" ? "png" : "jpg";
  const filePath = join(SCREENSHOTS_DIR, `screenshot-${Date.now()}.${ext}`);
  writeFileSync(filePath, Buffer.from(dataBase64, "base64"));
  return filePath;
}

// Every tool call gets logged here — this is what actually answers "which
// call burned the tokens", instead of guessing from a pasted transcript
// after the fact. One JSONL file per daemon process (= roughly one MCP
// client session), so a session's calls are easy to isolate and grep.
const LOGS_DIR = join(import.meta.dir, "..", "..", "logs");
try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
const LOG_FILE = join(LOGS_DIR, `session-${Date.now()}.jsonl`);

const PREVIEW_CHARS = 300;

function writeCallLog(entry: { ts: string; cmd: string; args: ToolArgs; durationMs: number; approxChars: number; approxTokens: number; hasImage: boolean; isError: boolean; source: string; preview: string; elementRole?: string; elementName?: string }): void {
  try { appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch {}
  console.error(`[tool:${entry.source}] ${entry.cmd} ${entry.durationMs}ms ~${entry.approxTokens}tok${entry.hasImage ? ' [image]' : ''}${entry.isError ? ' ERROR' : ''}`);
}

function logToolCall(name: string, args: ToolArgs, response: ToolCallResponse, durationMs: number): void {
  let approxChars = 0;
  let hasImage = false;
  let text = "";
  for (const item of response?.content ?? []) {
    if (item.type === "text") { approxChars += item.text?.length ?? 0; text += item.text ?? ""; }
    if (item.type === "image") { approxChars += item.data?.length ?? 0; hasImage = true; }
  }
  // click/type responses carry {role, name} (see background.ts's
  // getAxInfoForNode) so replay can re-resolve "the button named X" against
  // a fresh snapshot instead of trusting a backendDOMNodeId that's already
  // stale the moment the page reloads. Best-effort parse since `text` here
  // is whatever JSON.stringify produced for the raw command result.
  let elementRole: string | undefined, elementName: string | undefined;
  try {
    const parsed = JSON.parse(text) as { role?: string; name?: string };
    elementRole = parsed?.role;
    elementName = parsed?.name;
  } catch {}
  writeCallLog({
    ts: new Date().toISOString(),
    cmd: name,
    args,
    durationMs,
    approxChars,
    approxTokens: Math.round(approxChars / 4),
    hasImage,
    isError: !!response?.isError,
    source: "mcp",
    preview: text.slice(0, PREVIEW_CHARS),
    elementRole,
    elementName,
  });
}

// /execute (used by replay.ts and any other direct HTTP caller) bypasses the
// MCP layer entirely, so without this it was invisible to logs/ — the first
// investigation of "why didn't replay show up in any log file" traced back
// to exactly this gap.
// Covers both shapes this actually receives: a real ExtensionResponse
// relayed from the extension, and an ad-hoc {error, hint} object built
// locally on timeout — hence the loose Record rather than ExtensionResponse
// itself.
function logDirectCall(cmd: string | undefined, args: ToolArgs, response: Record<string, unknown> | undefined, durationMs: number): void {
  const json = JSON.stringify(response ?? {});
  const data = response?.data as { role?: string; name?: string } | undefined;
  writeCallLog({
    ts: new Date().toISOString(),
    cmd: cmd ?? "unknown",
    args,
    durationMs,
    approxChars: json.length,
    approxTokens: Math.round(json.length / 4),
    hasImage: false,
    elementRole: data?.role,
    elementName: data?.name,
    isError: response?.type === "error" || !!response?.error,
    source: "execute",
    preview: json.slice(0, PREVIEW_CHARS),
  });
}

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: ExtensionResponse) => void>();

// --- WebSocket & HTTP Server ---
const httpServer = serve({
  port: 8765,
  // Restrict to loopback only. Bun defaults to binding all interfaces, which
  // would otherwise let any other machine on the LAN drive this browser.
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (server.upgrade(req)) return;

    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/execute") {
      if (!extensionSocket) {
        return new Response(JSON.stringify({ error: "Extension not connected", hint: "Open chrome://extensions, make sure BrowserControl Agent is enabled, and reload it." }), { status: 503 });
      }

      return req.json().then((body: { cmd?: string } & Record<string, unknown>) => {
        const start = Date.now();
        return new Promise<Response>((resolve) => {
          const reqId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            if (pendingRequests.has(reqId)) {
              pendingRequests.delete(reqId);
              const timeoutBody = { error: "Timeout", hint: "The page may be stuck on a slow load or an unhandled dialog. Try again or navigate to a simpler page." };
              logDirectCall(body?.cmd, body, timeoutBody, Date.now() - start);
              resolve(new Response(JSON.stringify(timeoutBody), { status: 504 }));
            }
          }, 15000);

          pendingRequests.set(reqId, (extResponse) => {
            clearTimeout(timeout);
            logDirectCall(body?.cmd, body, extResponse as unknown as Record<string, unknown>, Date.now() - start);
            resolve(new Response(JSON.stringify(extResponse), { headers: { "Content-Type": "application/json" } }));
          });

          extensionSocket!.send(JSON.stringify({ id: reqId, ...body }));
        });
      }).catch(() => new Response("Invalid Request", { status: 400 }));
    }

    return new Response("BrowserControl Daemon is running.\n");
  },
  websocket: {
    open(ws) {
      console.error("🟢 Chrome Extension connected!");
      extensionSocket = ws;
    },
    message(ws, message) {
      try {
        const data = JSON.parse(message as string) as ExtensionResponse;
        if (data.id && pendingRequests.has(data.id)) {
          const resolve = pendingRequests.get(data.id)!;
          resolve(data);
          pendingRequests.delete(data.id);
        }
      } catch (e) {
        console.error("Error parsing message", e);
      }
    },
    close(ws) {
      console.error("🔴 Chrome Extension disconnected!");
      if (extensionSocket === ws) extensionSocket = null;
    },
  },
});

console.error(`🚀 BrowserControl HTTP/WS Daemon running at http://localhost:${httpServer.port}`);

// --- Helper to execute via WebSocket ---
async function executeCommand(cmd: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
  if (!extensionSocket) throw new Error("Extension not connected to Daemon. Open chrome://extensions and reload BrowserControl Agent.");

  const flowWarning = recordAndCheckFlow(cmd, args);

  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error("Timeout waiting for Chrome. The page may be stuck on a slow load or an unhandled dialog."));
    }, 15000);

    pendingRequests.set(reqId, (extResponse) => {
      clearTimeout(timeout);
      if (extResponse.type === 'error') reject(new Error(extResponse.error));
      else {
        const data = (extResponse.data ?? {}) as CommandResult;
        resolve(flowWarning ? { ...data, _flowWarning: flowWarning } : data);
      }
    });

    extensionSocket!.send(JSON.stringify({ id: reqId, cmd, ...args }));
  });
}

// --- MCP Server Setup ---
const mcpServer = new Server({
  name: "browsercontrol",
  version: "1.7.0",
}, {
  capabilities: { tools: {} },
  instructions: `
BrowserControl drives a real Chrome tab (grouped as "🤖 AI Workspace") via
your everyday browser's debugger, not a headless/isolated instance. All
tools operate on a single shared tab — call browser_navigate first to
establish it.

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
1. browser_navigate to the target URL.
2. browser_snapshot for a fast text list of interactive elements (id, role,
   name, value). If you're not fully confident which id is the right one
   (custom dropdowns, icon-only buttons, repeated labels), use
   browser_visual_snapshot instead — it draws a numbered box over every
   interactive element on a screenshot, so you can ground the id to a
   position before clicking.
3. browser_click / browser_type using the id from the snapshot. These
   dispatch real, trusted input events (same as a physical mouse/keyboard),
   so they exercise the actual event handlers a user would trigger.
4. browser_type only inserts text — it never submits anything on its own.
   To submit a search box or form, or navigate a custom dropdown, follow it
   with browser_press_key (Enter, Tab, Escape, arrows, ...).
5. After any action that changes the page (navigation, opening a modal,
   submitting a form), take a fresh snapshot before reusing an id — ids are
   backend DOM node ids and go stale once the page re-renders.

Tool selection — this is important for anything you intend to report as a
verified UI behavior:
- browser_click / browser_type / browser_press_key: the ONLY tools that
  count as testing real user interaction. Prefer them whenever you're
  checking that a button, link, or form field actually works. Each glides a
  visible cursor dot to the target and briefly outlines it (violet for
  click, cyan for type/key) — a multi-step animation (glide, pause, press,
  ripple) that takes a couple of seconds per action — so a human watching
  the tab can actually follow what's happening instead of it jumping
  instantly between fields. This adds real latency; it's intentional, not a
  bug. browser_evaluate does none of this.
- browser_evaluate: for reading state (localStorage, computed values) or
  test setup/teardown (e.g. seeding an auth token). Do NOT use it to click
  buttons or fill fields as a shortcut — setting element.value via JS does
  not reliably trigger React/Vue's onChange, so a broken input can look
  like it works when it doesn't. If you used evaluate to fill a form, say
  so explicitly rather than reporting it as a tested interaction.
- browser_screenshot: pure visual inspection (layout, spacing, colors) when
  you need to see rendering issues the accessibility tree can't show.
- browser_visual_snapshot: structure + visual grounding in one call, for
  when you need both an id to act on and confidence about its position.
- browser_inspect_element: browser_snapshot deliberately shows very little
  per element to stay cheap across a whole page. When you need to know WHY
  one specific element looks or behaves a certain way — which CSS rule set
  that color/spacing, what its computed layout is, whether it has a click/
  change listener attached — call browser_inspect_element on its id instead
  of trying to infer it from the snapshot or re-reading source files blind.
- browser_query_region: the middle tier between browser_snapshot (whole
  page, flat, cheap, but a form field's label can be 50 unrelated elements
  away in the list) and browser_inspect_element (one element, no surrounding
  context). Pass a CSS selector for the containing form/panel/row and get
  back a nested tree of just what's inside it — a label and its field are
  siblings in the same "children" array, so the association is structural,
  not something you infer from ordering. Prefer this over browser_snapshot
  when you're specifically trying to fill out or verify one form/section,
  and especially when browser_snapshot showed you fields with an empty name
  (no accessible label) that you need to correctly associate.

Both browser_screenshot and browser_visual_snapshot save the image to a file
on disk and give you the path in the text output. Inline image content is
OFF by default (set BROWSERCONTROL_INLINE_IMAGES=true to enable) because
some MCP clients — notably some Antigravity CLI versions — can't handle
image content from MCP servers, and a mishandled screenshot risks landing in
your context as raw base64 text: a single ~700KB PNG is roughly 230k tokens
that way. This is not hypothetical — it has burned a large chunk of a 5-hour
usage window in practice. Concretely:
- Never pass format:"png" unless you specifically need pixel-exact color
  values — it is 3-5x larger than the jpeg default for no benefit in
  routine "let me see the page" checks.
- Don't call browser_screenshot / browser_visual_snapshot on every step.
  Use browser_snapshot (cheap, text-only) as your default; reach for a
  screenshot only when you actually need to visually confirm layout/styling
  or ground an ambiguous click target.
- If your client doesn't render inline images, read the saved file path
  rather than re-requesting the screenshot hoping it renders differently.

Inspecting the network call behind a submit/action button (like the DevTools
Network tab):
1. browser_network_clear right before the click, so old page-load requests
   don't drown out the one you care about.
2. browser_click the submit/action button.
3. browser_network_requests to see what fired — defaults to XHR/Fetch/
   Document/WebSocket only (the actual API calls), not static assets.
4. browser_network_request_detail with a requestId from that list if you
   need the full request/response headers or body (e.g. to check the
   payload sent or the error message returned).
The network log also auto-clears on every browser_navigate.

If a command times out or errors, check the returned "hint" field before
retrying blindly — it usually points at the actual cause (stale node id,
extension not connected, unhandled dialog, etc).
`.trim(),
});

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browser_navigate",
        description: "Navigate to a URL",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
      },
      {
        name: "browser_snapshot",
        description: "Get the interactive elements on the page as a text list, filtered and deduplicated to save tokens. Each entry is {i, r, n, v?}: i=node id (pass to browser_click/browser_type/browser_inspect_element), r=role, n=accessible name, v=current value (omitted when empty). Fast and cheap, but you can't see WHERE on screen an id is. If you're not confident which id to click, use browser_visual_snapshot instead.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_visual_snapshot",
        description: "Like browser_snapshot, but also returns a screenshot with a numbered box drawn over every interactive element — the number is the same id you pass to browser_click/browser_type. Use this before clicking anything you're not 100% sure about (custom dropdowns, icon-only buttons, ambiguous labels), since guessing from the text list alone is how wrong-element clicks happen.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_query_region",
        description: "Scoped version of browser_snapshot: pass a CSS selector for a container (a form, a panel, a table row — whatever you can identify from the page source) and get back a nested tree (not a flat list) of just the elements inside it. Because it's nested, a field's label is literally its sibling in the same `children` array — you don't have to guess the association from position in a long flat list like with browser_snapshot. Capped at 150 elements; narrow the selector further if truncated.",
        inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector for the container to scope into" } }, required: ["selector"] }
      },
      {
        name: "browser_click",
        description: "Click an element by its Node ID (from browser_snapshot). Dispatches a real, trusted mouse event — use this instead of browser_evaluate whenever you're testing that a button/link/control actually works, since a JS-invoked .click() or a manually-set .value doesn't exercise the same code path a real user click does.",
        inputSchema: { type: "object", properties: { nodeId: { type: "number" } }, required: ["nodeId"] }
      },
      {
        name: "browser_type",
        description: "Focus the element with the given Node ID (from browser_snapshot) and type text into it as a real user would, one CDP input event at a time. Prefer this over browser_evaluate for filling form fields — setting element.value via JS does not reliably trigger React/Vue's onChange, so it can make a broken input look like it works.",
        inputSchema: { type: "object", properties: { text: { type: "string" }, nodeId: { type: "number", description: "Element to focus before typing. Omit only if the target is already focused." } }, required: ["text"] }
      },
      {
        name: "browser_press_key",
        description: "Press a single named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown) — dispatches a real keydown/keyup, distinct from browser_type which only inserts text and never submits anything on its own. Use this after browser_type to submit a search box or form (Enter), or to navigate a custom dropdown/menu (arrows + Enter).",
        inputSchema: { type: "object", properties: { key: { type: "string", description: "One of: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Home, End, PageUp, PageDown" }, nodeId: { type: "number", description: "Element to focus before pressing the key. Omit only if the target is already focused (e.g. right after browser_type)." } }, required: ["key"] }
      },
      {
        name: "browser_evaluate",
        description: "Evaluate arbitrary JavaScript on the page. Use this for reading state (e.g. localStorage, computed values) or for setup/teardown (e.g. seeding auth tokens) — NOT as a shortcut for clicking buttons or filling form fields, which won't verify real user interaction. Use browser_click/browser_type for anything you intend to report as a tested UI behavior.",
        inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }
      },
      {
        name: "browser_scroll",
        description: "Scroll the page by a pixel delta",
        inputSchema: { type: "object", properties: { deltaX: { type: "number" }, deltaY: { type: "number" } } }
      },
      {
        name: "browser_network_requests",
        description: "List network requests observed since the last navigate or browser_network_clear — like the DevTools Network tab. Defaults to XHR/Fetch/Document/WebSocket only (the calls an action button actually triggers), hiding static asset noise (images/css/fonts/scripts) unless you pass resourceTypes explicitly. Use browser_network_clear right before clicking a submit/action button, then call this after, to see exactly what request that click caused.",
        inputSchema: {
          type: "object",
          properties: {
            resourceTypes: { type: "array", items: { type: "string" }, description: "CDP resource type names (XHR, Fetch, Document, Script, Stylesheet, Image, Font, Media, WebSocket, ...). Overrides the default filter." },
            filter: { type: "string", description: "Only include requests whose URL contains this substring" },
            limit: { type: "number", description: "Max entries to return, most recent first. Default 50." }
          }
        }
      },
      {
        name: "browser_network_request_detail",
        description: "Get full detail for one request from browser_network_requests — headers, post body, and response body (fetched on demand, truncated if very large).",
        inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] }
      },
      {
        name: "browser_network_clear",
        description: "Clear the network log. Call this immediately before a submit/action click so browser_network_requests afterward only shows what that action triggered, not accumulated page-load noise. Also happens automatically on every browser_navigate.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_inspect_element",
        description: "Deep-dive on ONE element by id (from browser_snapshot/browser_visual_snapshot): outerHTML, which CSS rule/selector set its computed styles, key computed layout properties, and any event listeners attached (type only, not handler source). Expensive relative to browser_snapshot — use it only for the specific element you need to explain, not in a loop over every node.",
        inputSchema: { type: "object", properties: { nodeId: { type: "number" } }, required: ["nodeId"] }
      },
      {
        name: "browser_screenshot",
        description: "Capture a screenshot so you can visually inspect layout, styling, spacing, and rendering issues that the accessibility snapshot (text-only) can't show",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport" },
            format: { type: "string", enum: ["jpeg", "png"], description: "Leave unset (defaults to jpeg). PNG is 3-5x larger for typical UI screenshots and is almost never worth it — only pass 'png' if you specifically need pixel-exact color values, not for routine 'let me see the page' checks." },
            quality: { type: "number", description: "JPEG quality 0-100, default 80" }
          }
        }
      }
    ]
  };
});

async function handleToolCall(request: CallToolRequest): Promise<ToolCallResponse> {
  const { name, arguments: args } = request.params;
  try {
    let result: CommandResult | string;
    switch (name) {
      case "browser_navigate":
        result = await executeCommand("navigate", { url: args?.url });
        break;
      case "browser_snapshot":
        result = await executeCommand("snapshot");
        break;
      case "browser_query_region":
        result = await executeCommand("query_region", { selector: args?.selector });
        break;
      case "browser_visual_snapshot": {
        const snap = await executeCommand("visual_snapshot");
        if (!snap?.dataBase64) {
          return {
            content: [{ type: "text", text: `Error: ${snap?.error ?? 'Visual snapshot failed'}${snap?.hint ? ` (${snap.hint})` : ''}` }],
            isError: true,
          };
        }
        const snapFilePath = saveScreenshotToFile(snap.dataBase64 as string, 'jpeg');
        return {
          content: [
            ...(INLINE_IMAGES ? [{ type: "image" as const, data: snap.dataBase64 as string, mimeType: 'image/jpeg' }] : []),
            { type: "text", text: `${snap.message}\nScreenshot saved to ${snapFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to see the annotated boxes; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${snap._flowWarning ? `\n\n[${snap._flowWarning}]` : ''}\n\n${JSON.stringify(snap.nodes, null, 2)}` },
          ],
        };
      }
      case "browser_click":
        result = await executeCommand("click", { nodeId: args?.nodeId });
        break;
      case "browser_type":
        result = await executeCommand("type", { text: args?.text, nodeId: args?.nodeId });
        break;
      case "browser_press_key":
        result = await executeCommand("press_key", { key: args?.key, nodeId: args?.nodeId });
        break;
      case "browser_evaluate":
        result = await executeCommand("evaluate", { expression: args?.expression });
        break;
      case "browser_scroll":
        result = await executeCommand("scroll", { deltaX: args?.deltaX, deltaY: args?.deltaY });
        break;
      case "browser_network_requests":
        result = await executeCommand("network_requests", { resourceTypes: args?.resourceTypes, filter: args?.filter, limit: args?.limit });
        break;
      case "browser_network_request_detail":
        result = await executeCommand("network_request_detail", { requestId: args?.requestId });
        break;
      case "browser_network_clear":
        result = await executeCommand("network_clear");
        break;
      case "browser_inspect_element":
        result = await executeCommand("inspect_element", { nodeId: args?.nodeId });
        break;
      case "browser_screenshot": {
        const shot = await executeCommand("screenshot", {
          fullPage: args?.fullPage,
          format: args?.format,
          quality: args?.quality,
        });
        if (!shot?.dataBase64) {
          return {
            content: [{ type: "text", text: `Error: ${shot?.error ?? 'Screenshot failed'}${shot?.hint ? ` (${shot.hint})` : ''}` }],
            isError: true,
          };
        }
        const shotFilePath = saveScreenshotToFile(shot.dataBase64 as string, shot.format as string);
        return {
          content: [
            ...(INLINE_IMAGES ? [{ type: "image" as const, data: shot.dataBase64 as string, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg' }] : []),
            { type: "text", text: `Captured ${shot.format} screenshot (${args?.fullPage ? 'full page' : 'viewport'}). Saved to ${shotFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to view; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${shot._flowWarning ? `\n\n[${shot._flowWarning}]` : ''}` },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true
    };
  }
}

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const start = Date.now();
  const response = await handleToolCall(request);
  logToolCall(request.params.name, request.params.arguments, response, Date.now() - start);
  return response;
});

async function runMcp() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("🚀 MCP Server is connected to stdio");
}

runMcp().catch(e => console.error("MCP Server failed", e));

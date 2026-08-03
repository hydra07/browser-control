import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Redirect all console output to stderr to prevent corrupting MCP JSON-RPC over stdout
console.log = console.error;
console.info = console.error;

// Not all MCP clients render inline image content blocks (some Antigravity
// CLI versions can't handle images from MCP servers at all and error out).
// Always also save to disk and return the path as a guaranteed fallback.
const SCREENSHOTS_DIR = join(import.meta.dir, "..", "screenshots");
try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

function saveScreenshotToFile(dataBase64: string, format: string): string {
  const ext = format === "png" ? "png" : "jpg";
  const filePath = join(SCREENSHOTS_DIR, `screenshot-${Date.now()}.${ext}`);
  writeFileSync(filePath, Buffer.from(dataBase64, "base64"));
  return filePath;
}

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: any) => void>();

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

      return req.json().then(body => {
        return new Promise<Response>((resolve) => {
          const reqId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            if (pendingRequests.has(reqId)) {
              pendingRequests.delete(reqId);
              resolve(new Response(JSON.stringify({ error: "Timeout", hint: "The page may be stuck on a slow load or an unhandled dialog. Try again or navigate to a simpler page." }), { status: 504 }));
            }
          }, 15000);

          pendingRequests.set(reqId, (extResponse) => {
            clearTimeout(timeout);
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
        const data = JSON.parse(message as string);
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
async function executeCommand(cmd: string, args: any = {}): Promise<any> {
  if (!extensionSocket) throw new Error("Extension not connected to Daemon. Open chrome://extensions and reload BrowserControl Agent.");

  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error("Timeout waiting for Chrome. The page may be stuck on a slow load or an unhandled dialog."));
    }, 15000);
    
    pendingRequests.set(reqId, (extResponse) => {
      clearTimeout(timeout);
      if (extResponse.type === 'error') reject(new Error(extResponse.error));
      else resolve(extResponse.data);
    });
    
    extensionSocket!.send(JSON.stringify({ id: reqId, cmd, ...args }));
  });
}

// --- MCP Server Setup ---
const mcpServer = new Server({
  name: "browsercontrol",
  version: "1.6.0",
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
4. After any action that changes the page (navigation, opening a modal,
   submitting a form), take a fresh snapshot before reusing an id — ids are
   backend DOM node ids and go stale once the page re-renders.

Tool selection — this is important for anything you intend to report as a
verified UI behavior:
- browser_click / browser_type: the ONLY tools that count as testing real
  user interaction. Prefer them whenever you're checking that a button,
  link, or form field actually works. Each glides a visible cursor dot to
  the target and briefly outlines it (green for click, blue for type) —
  ~700ms of visible motion per action — so a human watching the tab can
  actually follow what's happening instead of it jumping instantly between
  fields. This adds real latency; it's intentional, not a bug.
  browser_evaluate does none of this.
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

Both browser_screenshot and browser_visual_snapshot return the image inline
AND save it to a file on disk (path given in the text output). Some MCP
clients (notably some Antigravity CLI versions) don't render inline image
content from MCP servers at all. If the image doesn't show up in your
client, read the saved file path instead of assuming the tool failed.

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
        description: "Get the interactive elements on the page as a text list (filtered to save quota): id, role, name, value. Fast and cheap, but you can't see WHERE on screen an id is. If you're not confident which id to click, use browser_visual_snapshot instead.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_visual_snapshot",
        description: "Like browser_snapshot, but also returns a screenshot with a numbered box drawn over every interactive element — the number is the same id you pass to browser_click/browser_type. Use this before clicking anything you're not 100% sure about (custom dropdowns, icon-only buttons, ambiguous labels), since guessing from the text list alone is how wrong-element clicks happen.",
        inputSchema: { type: "object", properties: {} }
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
        name: "browser_screenshot",
        description: "Capture a screenshot so you can visually inspect layout, styling, spacing, and rendering issues that the accessibility snapshot (text-only) can't show",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport" },
            format: { type: "string", enum: ["jpeg", "png"], description: "Defaults to jpeg (much smaller); use png only if you need lossless detail" },
            quality: { type: "number", description: "JPEG quality 0-100, default 80" }
          }
        }
      }
    ]
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result: any;
    switch (name) {
      case "browser_navigate":
        result = await executeCommand("navigate", { url: args?.url });
        break;
      case "browser_snapshot":
        result = await executeCommand("snapshot");
        break;
      case "browser_visual_snapshot": {
        const snap = await executeCommand("visual_snapshot");
        if (!snap?.dataBase64) {
          return {
            content: [{ type: "text", text: `Error: ${snap?.error ?? 'Visual snapshot failed'}${snap?.hint ? ` (${snap.hint})` : ''}` }],
            isError: true,
          };
        }
        const snapFilePath = saveScreenshotToFile(snap.dataBase64, 'jpeg');
        return {
          content: [
            { type: "image", data: snap.dataBase64, mimeType: 'image/jpeg' },
            { type: "text", text: `${snap.message}\nSaved to ${snapFilePath} (open this if the image above didn't render).\n\n${JSON.stringify(snap.nodes, null, 2)}` },
          ],
        };
      }
      case "browser_click":
        result = await executeCommand("click", { nodeId: args?.nodeId });
        break;
      case "browser_type":
        result = await executeCommand("type", { text: args?.text, nodeId: args?.nodeId });
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
        const shotFilePath = saveScreenshotToFile(shot.dataBase64, shot.format);
        return {
          content: [
            { type: "image", data: shot.dataBase64, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg' },
            { type: "text", text: `Captured ${shot.format} screenshot (${args?.fullPage ? 'full page' : 'viewport'}). Saved to ${shotFilePath} (open this if the image above didn't render).` },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function runMcp() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("🚀 MCP Server is connected to stdio");
}

runMcp().catch(e => console.error("MCP Server failed", e));

#!/usr/bin/env bun

/**
 * BrowserControl daemon: bootstraps data dirs/logging, bridges an MCP
 * stdio server to the Chrome extension over WebSocket/HTTP on
 * 127.0.0.1:8765, and wires the two together. Tool schemas live in
 * modules/tools/schemas.ts, per-action dispatch in modules/tools/handlers.ts
 * — this file is just the server itself. Also the root package.json's `bin`
 * entry, so `bunx github:<owner>/<repo>` can run it without a local
 * clone — see AGENTS.md.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BinaryOpcode, decodeBinaryPacket, type ExtensionResponse, type FlowStep } from "@browsercontrol/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import { IMAGES_DIR, LEGACY_LOGS_DIR, LOGS_DIR, VIDEOS_DIR } from "./configs/paths.js";
import { HOSTNAME, INLINE_IMAGES, PACKAGE_VERSION, PORT } from "./configs/server.js";
import { errorMessage } from "./libs/errorMessage.js";
import { Gateway } from "./libs/gateways.js";
import type { CommandResult } from "./libs/types.js";
import { logDirectCall, logToolCall } from "./modules/callLog/index.js";
import {
  abortActiveAgentQuery,
  detectAvailableAgents,
  executeCliAgentQuery,
  isAgentBusy,
  streamCliAgentQuery,
} from "./modules/cliAgent/index.js";
import * as dataStore from "./modules/dataStore/index.js";
import { recordAndCheckFlow } from "./modules/sessionFlow/index.js";
import * as streamSink from "./modules/streamSink/index.js";
import { handleToolCall } from "./modules/tools/handlers.js";
import { INSTRUCTIONS, TOOLS } from "./modules/tools/schemas.js";

// One id for the whole process: the log filename, dataStore's sessions row, and every docs block written.
const SESSION_ID = String(Date.now());

// stdout is the MCP JSON-RPC channel; redirect console output to stderr so nothing corrupts it.
console.log = console.error;
console.info = console.error;

for (const dir of [IMAGES_DIR, VIDEOS_DIR, LOGS_DIR]) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
}

// One-time best-effort migration: an older checkout may have a top-level logs/ dir from before it moved under data/.
try {
  if (existsSync(LEGACY_LOGS_DIR)) {
    for (const f of readdirSync(LEGACY_LOGS_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const dest = join(LOGS_DIR, f);
      if (existsSync(dest)) continue;
      try {
        renameSync(join(LEGACY_LOGS_DIR, f), dest);
      } catch {}
    }
  }
} catch {}

const LOG_FILE = join(LOGS_DIR, `session-${SESSION_ID}.jsonl`);
dataStore.initSession(SESSION_ID, { pid: process.pid });
dataStore.recordArtifact({ sessionId: SESSION_ID, kind: "log", path: LOG_FILE });

// Otherwise a killed/restarted daemon orphans any in-flight `claude` subprocess (cliAgent) until its own 90s timeout.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    abortActiveAgentQuery();
    dataStore.endSession(SESSION_ID);
    process.exit(0);
  });
}
process.on("exit", () => abortActiveAgentQuery());

function saveScreenshotToFile(dataBase64: string, format: string): string {
  const ext = format === "png" ? "png" : "jpg";
  const filePath = join(IMAGES_DIR, `screenshot-${Date.now()}.${ext}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  dataStore.recordArtifact({
    sessionId: SESSION_ID,
    kind: "image",
    path: filePath,
    source: "screenshot",
    sizeBytes: buf.length,
  });
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  return filePath;
}

function saveVideoToFile(dataBase64: string, format: string): string {
  const filePath = join(VIDEOS_DIR, `recording-${Date.now()}.${format}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  dataStore.recordArtifact({
    sessionId: SESSION_ID,
    kind: "video",
    path: filePath,
    source: "recording",
    sizeBytes: buf.length,
  });
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  return filePath;
}

// --- WebSocket/HTTP bridge to the Chrome extension ---

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: ExtensionResponse) => void>();

const httpServer = serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req, server) {
    if (server.upgrade(req)) return;

    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/execute") {
      if (!extensionSocket) {
        return new Response(
          JSON.stringify({
            error: "Extension not connected",
            hint: "Open chrome://extensions, make sure BrowserControl Agent is enabled, and reload it.",
          }),
          { status: 503 },
        );
      }

      let body: { cmd?: string } & Record<string, unknown>;
      try {
        body = (await req.json()) as { cmd?: string } & Record<string, unknown>;
      } catch {
        return new Response("Invalid Request", { status: 400 });
      }

      const start = Date.now();
      const timeoutBudget = typeof body?.timeoutMs === "number" ? body.timeoutMs : 30000;
      return new Promise<Response>((resolve) => {
        const reqId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          if (pendingRequests.has(reqId)) {
            pendingRequests.delete(reqId);
            const timeoutBody = {
              error: "Timeout",
              hint: "The page may be stuck on a slow load or an unhandled dialog. Try again or navigate to a simpler page.",
            };
            logDirectCall(LOG_FILE, body?.cmd, body, timeoutBody, Date.now() - start);
            resolve(new Response(JSON.stringify(timeoutBody), { status: 504 }));
          }
        }, timeoutBudget);

        pendingRequests.set(reqId, (extResponse) => {
          clearTimeout(timeout);
          logDirectCall(
            LOG_FILE,
            body?.cmd,
            body,
            extResponse as unknown as Record<string, unknown>,
            Date.now() - start,
          );
          resolve(new Response(JSON.stringify(extResponse), { headers: { "Content-Type": "application/json" } }));
        });

        extensionSocket!.send(JSON.stringify({ id: reqId, ...body }));
      });
    }

    // Talked to directly by the side panel (a browser page, not an MCP client) — same pattern as /execute.
    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    const JSON_CORS_HEADERS = {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Read-only MCP endpoint for the chat's own CLI agent (handleChatMcpRequest below), wired via cliAgent's --mcp-config.
    if (url.pathname === "/mcp") {
      return handleChatMcpRequest(req);
    }

    if (req.method === "GET" && url.pathname === "/flows") {
      /**
       * A thrown exception here (e.g. a transient SQLITE_BUSY under
       * concurrent access) must not escape as an unhandled throw — that
       * risks the connection resetting instead of a clean JSON response,
       * which the side panel's fetch() can't distinguish from the daemon
       * being genuinely down.
       */
      try {
        return new Response(JSON.stringify({ flows: dataStore.listFlows() }), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    if (req.method === "POST" && url.pathname === "/flows") {
      try {
        const body = (await req.json()) as {
          id?: string;
          name: string;
          description?: string;
          domain?: string;
          steps: FlowStep[];
        };
        if (!body.name || !Array.isArray(body.steps) || body.steps.length === 0) {
          return new Response(JSON.stringify({ error: "Missing name or steps array" }), {
            status: 400,
            headers: JSON_CORS_HEADERS,
          });
        }
        const saved = dataStore.saveFlow(body);
        return new Response(JSON.stringify({ success: true, flow: saved }), {
          status: 201,
          headers: JSON_CORS_HEADERS,
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500,
          headers: JSON_CORS_HEADERS,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/execute") {
      try {
        const body = (await req.json()) as { cmd: string; [key: string]: unknown };
        if (!body.cmd) {
          return new Response(JSON.stringify({ error: "Missing cmd" }), {
            status: 400,
            headers: JSON_CORS_HEADERS,
          });
        }
        const { cmd, ...args } = body;
        const res = await executeCommand(cmd, args);
        return new Response(JSON.stringify({ success: true, result: res }), {
          headers: JSON_CORS_HEADERS,
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500,
          headers: JSON_CORS_HEADERS,
        });
      }
    }

    /**
     * Full flow detail (including steps) for the panel's behavior inspector
     * — GET /flows only returns list metadata. /flows/:id/run and DELETE
     * below share the same :id shape, so this needs to exclude "/run".
     */
    const getFlowMatch = req.method === "GET" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (getFlowMatch) {
      const flowId = decodeURIComponent(getFlowMatch[1] ?? "");
      let flow: ReturnType<typeof dataStore.getFlow>;
      try {
        flow = dataStore.getFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), {
          status: 404,
          headers: JSON_CORS_HEADERS,
        });
      }
      return new Response(JSON.stringify({ flow }), { headers: JSON_CORS_HEADERS });
    }

    /**
     * Polled by the side panel for a connection badge — the daemon's HTTP
     * server being reachable only proves this process is up; whether any
     * tool call will actually work depends on whether the extension's
     * background worker has a live WebSocket here (the `open`/`close`
     * websocket handlers below set/clear extensionSocket).
     */
    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify({ extensionConnected: extensionSocket != null, version: PACKAGE_VERSION }), {
        headers: JSON_CORS_HEADERS,
      });
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      try {
        const querySessionId = url.searchParams.get("sessionId") || SESSION_ID;
        const metrics = dataStore.getBenchmarkMetrics(querySessionId);
        return new Response(JSON.stringify(metrics), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    // Sandboxed CLI Agent Query Endpoint (user-configured custom CLI command or agy/claude)
    if (req.method === "POST" && url.pathname === "/cli-agent/query") {
      try {
        const body = (await req.json()) as {
          prompt: string;
          url?: string;
          title?: string;
          selectionText?: string;
          compactContext?: string;
          customCommand?: string;
          sessionId?: string;
        };
        const res = await executeCliAgentQuery({
          prompt: body.prompt,
          url: body.url,
          title: body.title,
          selectionText: body.selectionText,
          compactContext: body.compactContext,
          customCommand: body.customCommand,
          sessionId: body.sessionId,
        });
        return new Response(JSON.stringify(res), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 400, headers: JSON_CORS_HEADERS });
      }
    }

    if (req.method === "POST" && url.pathname === "/cli-agent/stream") {
      try {
        const body = (await req.json()) as {
          prompt: string;
          url?: string;
          title?: string;
          selectionText?: string;
          compactContext?: string;
          customCommand?: string;
          sessionId?: string;
        };
        const stream = streamCliAgentQuery({
          prompt: body.prompt,
          url: body.url,
          title: body.title,
          selectionText: body.selectionText,
          compactContext: body.compactContext,
          customCommand: body.customCommand,
          sessionId: body.sessionId,
        });
        return new Response(stream, {
          headers: {
            ...JSON_CORS_HEADERS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 400, headers: JSON_CORS_HEADERS });
      }
    }

    if (req.method === "POST" && url.pathname === "/cli-agent/abort") {
      const aborted = abortActiveAgentQuery();
      return new Response(JSON.stringify({ success: aborted }), { headers: JSON_CORS_HEADERS });
    }

    if (req.method === "GET" && url.pathname === "/cli-agent/status") {
      const agents = detectAvailableAgents();
      const busy = isAgentBusy();
      return new Response(JSON.stringify({ ...agents, isBusy: busy }), { headers: JSON_CORS_HEADERS });
    }

    const deleteMatch = req.method === "DELETE" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (deleteMatch) {
      const flowId = decodeURIComponent(deleteMatch[1] ?? "");
      let deleted: boolean;
      try {
        deleted = dataStore.deleteFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!deleted) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), {
          status: 404,
          headers: JSON_CORS_HEADERS,
        });
      }
      return new Response(JSON.stringify({ success: true }), { headers: JSON_CORS_HEADERS });
    }

    const runMatch = req.method === "POST" ? url.pathname.match(/^\/flows\/([^/]+)\/run$/) : null;
    if (runMatch) {
      const flowId = decodeURIComponent(runMatch[1] ?? "");
      let flow: ReturnType<typeof dataStore.getFlow>;
      try {
        flow = dataStore.getFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), {
          status: 404,
          headers: JSON_CORS_HEADERS,
        });
      }
      if (!extensionSocket) {
        return new Response(
          JSON.stringify({
            error: "Extension not connected",
            hint: "Open chrome://extensions, make sure BrowserControl Agent is enabled, and reload it.",
          }),
          { status: 503, headers: JSON_CORS_HEADERS },
        );
      }
      /**
       * The panel's Run button has no MCP session (no prior navigate), so
       * background.ts's dispatchCommand needs the flow's own domain to
       * auto-navigate there first if the current tab is on the wrong page.
       */
      try {
        const report = await executeCommand("run_flow", { steps: flow.steps, domain: flow.domain ?? undefined });
        return new Response(JSON.stringify(report), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    return new Response("BrowserControl Daemon is running.\n");
  },
  websocket: {
    open(ws) {
      console.error("[daemon] Chrome extension connected");
      extensionSocket = ws;
    },
    message(_ws, message) {
      if (typeof message !== "string") {
        const rawBytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        const packet = decodeBinaryPacket(rawBytes);
        if (packet) {
          if (packet.opcode === BinaryOpcode.VIDEO_CHUNK) {
            streamSink.appendVideoChunk(packet.payload);
            return;
          }
        }
        return;
      }

      try {
        const data = JSON.parse(message) as ExtensionResponse;
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
      console.error("[daemon] Chrome extension disconnected");
      if (extensionSocket === ws) extensionSocket = null;
    },
  },
});

console.error(`[daemon] HTTP/WS daemon running at http://localhost:${httpServer.port}`);

/**
 * Relays one command to the extension over the WS bridge and waits for its
 * response. `timeoutMs` defaults to 15s (sized for CDP round trips);
 * stop_capture passes a longer one since it has to flush the MediaRecorder
 * and base64-encode a multi-MB blob before it can respond.
 */
async function executeCommand(
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<CommandResult> {
  if (!extensionSocket)
    throw new Error("Extension not connected to Daemon. Open chrome://extensions and reload BrowserControl Agent.");

  const flowWarning = recordAndCheckFlow(cmd, args);
  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error("Timeout waiting for Chrome. The page may be stuck on a slow load or an unhandled dialog."));
    }, timeoutMs);

    pendingRequests.set(reqId, (extResponse) => {
      clearTimeout(timeout);
      if (extResponse.type === "error") reject(new Error(extResponse.error));
      else {
        const data = (extResponse.data ?? {}) as CommandResult;
        resolve(flowWarning ? { ...data, _flowWarning: flowWarning } : data);
      }
    });

    extensionSocket!.send(JSON.stringify({ id: reqId, cmd, ...args }));
  });
}

// --- MCP server ---

const mcpServer = new Server(
  { name: "browsercontrol", version: PACKAGE_VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const start = Date.now();
  dataStore.recordToolCall(SESSION_ID);
  const response = await handleToolCall(request, {
    executeCommand,
    sessionId: SESSION_ID,
    inlineImages: INLINE_IMAGES,
    saveScreenshotToFile,
    saveVideoToFile,
  });

  // Logged by the internal action that ran, not the gateway tool name — falls back to the tool name if `action` is missing.
  const { action: loggedAction, ...restArgs } = (request.params.arguments ?? {}) as Record<string, unknown>;
  const logCmd = typeof loggedAction === "string" && loggedAction ? loggedAction : request.params.name;
  logToolCall(LOG_FILE, logCmd, restArgs, response, Date.now() - start);
  return response;
});

async function runMcp() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[daemon] MCP server connected to stdio");
}

runMcp().catch((e) => console.error("MCP Server failed", e));

/**
 * Read-only MCP server over HTTP, for the sidepanel chat's own CLI agent
 * (cliAgent) to attach to via --mcp-config. Only browser_inspect is
 * exposed — the chat agent should never click/type/navigate on its own.
 */
const CHAT_TOOLS = TOOLS.filter((t) => t.name === Gateway.Inspect);

/**
 * A stateless WebStandardStreamableHTTPServerTransport can only ever
 * `handleRequest` once (the SDK throws on reuse), and a Server can only
 * ever `connect()` to one transport — so both are built fresh per request
 * rather than module-level singletons.
 */
function handleChatMcpRequest(req: Request): Promise<Response> {
  const server = new Server({ name: "browsercontrol-chat", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CHAT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = await handleToolCall(request, {
      executeCommand,
      sessionId: SESSION_ID,
      inlineImages: INLINE_IMAGES,
      saveScreenshotToFile,
      saveVideoToFile,
    });
    const { action: loggedAction, ...restArgs } = (request.params.arguments ?? {}) as Record<string, unknown>;
    const logCmd = typeof loggedAction === "string" && loggedAction ? loggedAction : request.params.name;
    logToolCall(LOG_FILE, `chat:${logCmd}`, restArgs, response, 0);
    return response;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  return server.connect(transport).then(() => transport.handleRequest(req));
}

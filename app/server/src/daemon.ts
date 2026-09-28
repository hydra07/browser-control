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
import {
  BinaryOpcode,
  BROWSER_COMMAND_NAMES,
  decodeBinaryPacket,
  type EvidenceRun,
  type EvidenceTimelineEvent,
  type ExtensionResponse,
  type FlowStep,
} from "@browsercontrol/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import { extractBearerToken, isAuthTokenValid, loadAuthToken } from "./configs/auth.js";
import { EVIDENCE_DIR, IMAGES_DIR, LEGACY_LOGS_DIR, LOGS_DIR, VIDEOS_DIR } from "./configs/paths.js";
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
import { filterTools, parseCapabilityProfile, profileInstructions } from "./modules/tools/capabilities.js";
import { handleToolCall } from "./modules/tools/handlers.js";
import { INSTRUCTIONS, TOOLS } from "./modules/tools/schemas.js";
import type { StoredArtifact } from "./modules/tools/types.js";

// One id for the whole process: the log filename, dataStore's sessions row, and every docs block written.
const SESSION_ID = String(Date.now());

// stdout is the MCP JSON-RPC channel; redirect console output to stderr so nothing corrupts it.
console.log = console.error;
console.info = console.error;

for (const dir of [IMAGES_DIR, VIDEOS_DIR, LOGS_DIR, EVIDENCE_DIR]) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
}

const DAEMON_AUTH_TOKEN = loadAuthToken();
const CAPABILITY_PROFILE = parseCapabilityProfile(process.env.BROWSERCONTROL_PROFILE);
const WS_PROTOCOL_VERSION = 2;
const WS_AUTH_TIMEOUT_MS = 3000;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
const HTTP_COMMANDS: ReadonlySet<string> = new Set(BROWSER_COMMAND_NAMES);

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

function saveScreenshotToFile(dataBase64: string, format: string): StoredArtifact {
  const ext = format === "png" ? "png" : "jpg";
  const filePath = join(IMAGES_DIR, `screenshot-${Date.now()}.${ext}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  const rowId = dataStore.recordArtifact({
    sessionId: SESSION_ID,
    kind: "image",
    path: filePath,
    source: "screenshot",
    profile: "step",
    mimeType: format === "png" ? "image/png" : "image/jpeg",
    redacted: false,
    sizeBytes: buf.length,
  });
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  return { path: filePath, ref: dataStore.artifactRefFor(rowId, "image", buf.length) };
}

function saveVideoToFile(dataBase64: string, format: string): StoredArtifact {
  const filePath = join(VIDEOS_DIR, `recording-${Date.now()}.${format}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  const rowId = dataStore.recordArtifact({
    sessionId: SESSION_ID,
    kind: "video",
    path: filePath,
    source: "recording",
    profile: "flow",
    mimeType: "video/webm",
    redacted: false,
    sizeBytes: buf.length,
  });
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
    Bun.gc(true);
  }
  return { path: filePath, ref: dataStore.artifactRefFor(rowId, "video", buf.length) };
}

function saveEvidenceTrack(input: { overview: EvidenceRun; events: EvidenceTimelineEvent[] }): StoredArtifact {
  const filePath = join(EVIDENCE_DIR, `timeline-${Date.now()}.json`);
  const body = JSON.stringify(input);
  const byteSize = Buffer.byteLength(body, "utf8");
  writeFileSync(filePath, body, "utf8");
  const rowId = dataStore.recordArtifact({
    sessionId: SESSION_ID,
    kind: "trace",
    path: filePath,
    source: "evidence_timeline",
    profile: input.overview.profile,
    mimeType: "application/json",
    redacted: true,
    sizeBytes: byteSize,
    flowId: input.overview.flowId,
  });
  return { path: filePath, ref: dataStore.artifactRefFor(rowId, "trace", byteSize, true) };
}

// --- WebSocket/HTTP bridge to the Chrome extension ---

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: ExtensionResponse) => void>();
type SocketPhase = "AUTHENTICATING" | "READY";
type SocketState = { phase: SocketPhase; authTimer: ReturnType<typeof setTimeout> };
const socketStates = new Map<ServerWebSocket<unknown>, SocketState>();

const configuredExtensionOrigin = process.env.BROWSERCONTROL_EXTENSION_ORIGIN?.trim();

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (configuredExtensionOrigin) return origin === configuredExtensionOrigin;
  return origin.startsWith("chrome-extension://");
}

function corsHeaders(req: Request, includeContentType = false): Headers {
  const headers = new Headers();
  if (includeContentType) headers.set("Content-Type", "application/json");
  const origin = req.headers.get("origin");
  if (origin && isAllowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  if (origin) headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return headers;
}

function isAuthorized(req: Request): boolean {
  return isAuthTokenValid(DAEMON_AUTH_TOKEN, extractBearerToken(req));
}

function jsonError(req: Request, status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: corsHeaders(req, true) });
}

class RequestBodyError extends Error {
  public readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

async function readJsonBody<T>(req: Request): Promise<T> {
  if (!req.body) throw new RequestBodyError("Request body must not be empty", 400);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyError(`Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`, 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new RequestBodyError("Request body must be valid JSON", 400);
  }
}

function requestErrorStatus(error: unknown, fallback: number): number {
  return error instanceof RequestBodyError ? error.status : fallback;
}

function validateAgentSelection(agentId: unknown, effort: unknown): string | null {
  if (agentId !== undefined && agentId !== "claude" && agentId !== "agy") return "Unsupported CLI agent";
  if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
    return "Unsupported CLI effort; expected low, medium, or high";
  }
  if (effort !== undefined && agentId !== "agy") return "CLI effort is only supported for agy";
  return null;
}

function requestBodyLimit(req: Request): Response | null {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return null;
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return null;
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > MAX_HTTP_BODY_BYTES
    ? jsonError(req, 413, `Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`)
    : null;
}

const httpServer = serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req, server) {
    const url = new URL(req.url);
    const upgrade = req.headers.get("upgrade")?.toLowerCase();
    if (upgrade === "websocket" && url.pathname === "/") {
      if (!isAllowedOrigin(req.headers.get("origin"))) return jsonError(req, 403, "Origin not allowed");
      if (server.upgrade(req)) return;
      return jsonError(req, 400, "WebSocket upgrade failed");
    }

    if (!isAllowedOrigin(req.headers.get("origin"))) return jsonError(req, 403, "Origin not allowed");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (!isAuthorized(req)) return jsonError(req, 401, "Unauthorized");
    const bodyLimitResponse = requestBodyLimit(req);
    if (bodyLimitResponse) return bodyLimitResponse;

    const JSON_CORS_HEADERS = corsHeaders(req, true);
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
        const body = await readJsonBody<{
          id?: string;
          name: string;
          description?: string;
          domain?: string;
          steps: FlowStep[];
        }>(req);
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
          status: requestErrorStatus(e, 500),
          headers: JSON_CORS_HEADERS,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/execute") {
      if (!extensionSocket) {
        return jsonError(req, 503, "Extension not connected");
      }
      const start = Date.now();
      try {
        const body = await readJsonBody<{ cmd?: string; timeoutMs?: unknown } & Record<string, unknown>>(req);
        if (typeof body.cmd !== "string" || body.cmd.length === 0) {
          return jsonError(req, 400, "Missing cmd");
        }
        if (!HTTP_COMMANDS.has(body.cmd)) return jsonError(req, 400, "Unsupported command");
        const { cmd, timeoutMs: requestedTimeout, ...args } = body;
        const timeoutMs =
          typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout)
            ? Math.min(Math.max(Math.round(requestedTimeout), 1000), 120000)
            : 30000;
        const result = await executeCommand(cmd, args, timeoutMs);
        logDirectCall(LOG_FILE, cmd, body, result, Date.now() - start);
        return new Response(JSON.stringify({ success: true, result }), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        const error = { error: errorMessage(e) };
        logDirectCall(LOG_FILE, undefined, {}, error, Date.now() - start);
        return new Response(JSON.stringify(error), {
          status: requestErrorStatus(e, 500),
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
        const body = await readJsonBody<{
          prompt: string;
          url?: string;
          title?: string;
          selectionText?: string;
          compactContext?: string;
          agentId?: "claude" | "agy";
          effort?: "low" | "medium" | "high";
          sessionId?: string;
        }>(req);
        const selectionError = validateAgentSelection(body.agentId, body.effort);
        if (selectionError) return jsonError(req, 400, selectionError);
        const res = await executeCliAgentQuery({
          prompt: body.prompt,
          url: body.url,
          title: body.title,
          selectionText: body.selectionText,
          compactContext: body.compactContext,
          agentId: body.agentId,
          effort: body.effort,
          sessionId: body.sessionId,
        });
        return new Response(JSON.stringify(res), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: requestErrorStatus(e, 400),
          headers: JSON_CORS_HEADERS,
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/cli-agent/stream") {
      try {
        const body = await readJsonBody<{
          prompt: string;
          url?: string;
          title?: string;
          selectionText?: string;
          compactContext?: string;
          agentId?: "claude" | "agy";
          effort?: "low" | "medium" | "high";
          sessionId?: string;
        }>(req);
        const selectionError = validateAgentSelection(body.agentId, body.effort);
        if (selectionError) return jsonError(req, 400, selectionError);
        const stream = streamCliAgentQuery({
          prompt: body.prompt,
          url: body.url,
          title: body.title,
          selectionText: body.selectionText,
          compactContext: body.compactContext,
          agentId: body.agentId,
          effort: body.effort,
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
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: requestErrorStatus(e, 400),
          headers: JSON_CORS_HEADERS,
        });
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

    return new Response("Not found\n", { status: 404, headers: corsHeaders(req) });
  },
  websocket: {
    open(ws) {
      const authTimer = setTimeout(() => {
        const state = socketStates.get(ws);
        if (state?.phase !== "AUTHENTICATING") return;
        socketStates.delete(ws);
        ws.close(1008, "Authentication timeout");
      }, WS_AUTH_TIMEOUT_MS);
      socketStates.set(ws, { phase: "AUTHENTICATING", authTimer });
      console.error("[daemon] Chrome extension socket opened; awaiting hello");
    },
    message(ws, message) {
      const messageBytes =
        typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
      if (messageBytes > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, "WebSocket message too large");
        return;
      }

      const state = socketStates.get(ws);
      if (!state) return;

      if (state.phase !== "READY") {
        if (typeof message !== "string") {
          socketStates.delete(ws);
          clearTimeout(state.authTimer);
          ws.close(1008, "Authentication required");
          return;
        }

        let hello: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(message);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("hello must be an object");
          hello = parsed as Record<string, unknown>;
        } catch {
          socketStates.delete(ws);
          clearTimeout(state.authTimer);
          ws.close(1008, "Invalid hello");
          return;
        }

        const authenticated =
          hello.type === "hello" &&
          hello.protocolVersion === WS_PROTOCOL_VERSION &&
          hello.role === "extension" &&
          typeof hello.token === "string" &&
          isAuthTokenValid(DAEMON_AUTH_TOKEN, hello.token);
        if (!authenticated) {
          socketStates.delete(ws);
          clearTimeout(state.authTimer);
          ws.close(1008, "Authentication failed");
          return;
        }

        clearTimeout(state.authTimer);
        state.phase = "READY";
        const previousSocket = extensionSocket;
        extensionSocket = ws;
        ws.send(
          JSON.stringify({ type: "hello_ack", protocolVersion: WS_PROTOCOL_VERSION, serverVersion: PACKAGE_VERSION }),
        );
        console.error("[daemon] Chrome extension authenticated");
        if (previousSocket && previousSocket !== ws)
          previousSocket.close(4001, "Replaced by a newer extension connection");
        return;
      }

      if (typeof message !== "string") {
        const rawBytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        const packet = decodeBinaryPacket(rawBytes);
        if (packet?.opcode === BinaryOpcode.VIDEO_CHUNK) {
          streamSink.appendVideoChunk(packet.payload);
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
      const state = socketStates.get(ws);
      if (state) {
        clearTimeout(state.authTimer);
        socketStates.delete(ws);
      }
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

    extensionSocket!.send(JSON.stringify({ id: reqId, cmd, ...args, sessionId: SESSION_ID }));
  });
}

// --- MCP server ---

const mcpServer = new Server(
  { name: "browsercontrol", version: PACKAGE_VERSION },
  { capabilities: { tools: {} }, instructions: profileInstructions(INSTRUCTIONS, CAPABILITY_PROFILE) },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: filterTools(TOOLS, CAPABILITY_PROFILE) }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const start = Date.now();
  dataStore.recordToolCall(SESSION_ID);
  const response = await handleToolCall(request, {
    executeCommand,
    sessionId: SESSION_ID,
    inlineImages: INLINE_IMAGES,
    saveScreenshotToFile,
    saveVideoToFile,
    saveEvidenceTrack,
    capabilityProfile: CAPABILITY_PROFILE,
  });

  // Logged by the internal action that ran, not the gateway tool name — falls back to the tool name if `action` is missing.
  const { action: loggedAction, ...restArgs } = (request.params.arguments ?? {}) as Record<string, unknown>;
  const logCmd = typeof loggedAction === "string" && loggedAction ? loggedAction : request.params.name;
  logToolCall(LOG_FILE, logCmd, restArgs, response, Date.now() - start);
  return response;
});

async function runMcp(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("[daemon] MCP server connected to stdio");
}

let shuttingDown = false;

/** Releases the fixed loopback port when an MCP client closes its stdio transport. */
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  httpServer.stop(true);
}

process.stdin.once("end", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

runMcp().catch((e) => {
  console.error("MCP Server failed", e);
  shutdown();
});

/**
 * Read-only MCP server over HTTP, for the sidepanel chat's own CLI agent
 * (cliAgent) to attach to via --mcp-config. Only browser_inspect is
 * exposed — the chat agent should never click/type/navigate on its own.
 */
const CHAT_TOOLS = filterTools(TOOLS, CAPABILITY_PROFILE).filter((t) => t.name === Gateway.Inspect);

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
      saveEvidenceTrack,
      capabilityProfile: CAPABILITY_PROFILE,
    });
    const { action: loggedAction, ...restArgs } = (request.params.arguments ?? {}) as Record<string, unknown>;
    const logCmd = typeof loggedAction === "string" && loggedAction ? loggedAction : request.params.name;
    logToolCall(LOG_FILE, `chat:${logCmd}`, restArgs, response, 0);
    return response;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  return server.connect(transport).then(() => transport.handleRequest(req));
}

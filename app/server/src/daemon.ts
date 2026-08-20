#!/usr/bin/env bun
// BrowserControl daemon: bootstraps data dirs/logging, bridges an MCP
// stdio server to the Chrome extension over WebSocket/HTTP on
// 127.0.0.1:8765, and wires the two together. Tool schemas live in
// lib/toolSchemas.ts, per-action dispatch in lib/toolHandlers.ts — this
// file is just the server itself. Also the root package.json's `bin`
// entry, so `bunx github:<owner>/<repo>` can run it without a local
// clone — see AGENTS.md.

import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordAndCheckFlow } from "./lib/sessionFlow.js";
import * as dataStore from "./lib/dataStore.js";
import { logToolCall, logDirectCall } from "./lib/callLog.js";
import { TOOLS, INSTRUCTIONS } from "./lib/toolSchemas.js";
import { handleToolCall } from "./lib/toolHandlers.js";
import type { CommandResult } from "./lib/types.js";
import type { ExtensionResponse } from "@browsercontrol/shared";
import pkg from "../package.json" with { type: "json" };

// One id for the whole process: the log filename, dataStore's sessions
// row, and every docs block this process writes.
const SESSION_ID = String(Date.now());

// @browsercontrol/server's own version, not the extension's manifest.json
// — the two version independently since the monorepo split.
const PACKAGE_VERSION: string = pkg.version ?? "0.0.0";

// stdout is the MCP JSON-RPC channel; redirect console output to stderr so
// nothing corrupts it.
console.log = console.error;
console.info = console.error;

// Some MCP clients (older Antigravity CLI builds) can't render inline
// image content — a mishandled screenshot then lands in context as raw
// base64 (~230k tokens for a ~700KB PNG). Default to file-only.
const INLINE_IMAGES = process.env.BROWSERCONTROL_INLINE_IMAGES === "true";

const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const VIDEOS_DIR = join(DATA_DIR, "videos");
const LOGS_DIR = join(DATA_DIR, "logs");
for (const dir of [IMAGES_DIR, VIDEOS_DIR, LOGS_DIR]) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

// One-time best-effort migration: an older checkout may still have a
// top-level logs/ dir from before it moved under data/.
try {
  const legacyLogsDir = join(import.meta.dir, "..", "..", "..", "logs");
  if (existsSync(legacyLogsDir)) {
    for (const f of readdirSync(legacyLogsDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const dest = join(LOGS_DIR, f);
      if (existsSync(dest)) continue;
      try { renameSync(join(legacyLogsDir, f), dest); } catch {}
    }
  }
} catch {}

const LOG_FILE = join(LOGS_DIR, `session-${SESSION_ID}.jsonl`);
dataStore.initSession(SESSION_ID, { pid: process.pid });
dataStore.recordArtifact({ sessionId: SESSION_ID, kind: "log", path: LOG_FILE });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    dataStore.endSession(SESSION_ID);
    process.exit(0);
  });
}

function saveScreenshotToFile(dataBase64: string, format: string): string {
  const ext = format === "png" ? "png" : "jpg";
  const filePath = join(IMAGES_DIR, `screenshot-${Date.now()}.${ext}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  dataStore.recordArtifact({ sessionId: SESSION_ID, kind: "image", path: filePath, source: "screenshot", sizeBytes: buf.length });
  return filePath;
}

function saveVideoToFile(dataBase64: string, format: string): string {
  const filePath = join(VIDEOS_DIR, `recording-${Date.now()}.${format}`);
  const buf = Buffer.from(dataBase64, "base64");
  writeFileSync(filePath, buf);
  dataStore.recordArtifact({ sessionId: SESSION_ID, kind: "video", path: filePath, source: "recording", sizeBytes: buf.length });
  return filePath;
}

// --- WebSocket/HTTP bridge to the Chrome extension ---

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: ExtensionResponse) => void>();

const httpServer = serve({
  port: 8765,
  hostname: "127.0.0.1", // loopback only — Bun defaults to all interfaces
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
              logDirectCall(LOG_FILE, body?.cmd, body, timeoutBody, Date.now() - start);
              resolve(new Response(JSON.stringify(timeoutBody), { status: 504 }));
            }
          }, 15000);

          pendingRequests.set(reqId, (extResponse) => {
            clearTimeout(timeout);
            logDirectCall(LOG_FILE, body?.cmd, body, extResponse as unknown as Record<string, unknown>, Date.now() - start);
            resolve(new Response(JSON.stringify(extResponse), { headers: { "Content-Type": "application/json" } }));
          });

          extensionSocket!.send(JSON.stringify({ id: reqId, ...body }));
        });
      }).catch(() => new Response("Invalid Request", { status: 400 }));
    }

    // Talked to directly by the side panel (a browser page, not an MCP
    // client) — same pattern as /execute, for browsing/running saved flows.
    const JSON_CORS_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    if (req.method === "GET" && url.pathname === "/flows") {
      // A thrown exception here (e.g. a transient SQLITE_BUSY under
      // concurrent access) must not escape as an unhandled throw — that
      // risks the connection resetting instead of a clean JSON response,
      // which the side panel's fetch() can't distinguish from the daemon
      // being genuinely down.
      try {
        return new Response(JSON.stringify({ flows: dataStore.listFlows() }), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    // Full flow detail (including steps) for the panel's behavior inspector
    // — GET /flows only returns list metadata. Matched after /flows/:id/run
    // and DELETE below share the same :id shape, so this needs to exclude
    // "/run" specifically.
    const getFlowMatch = req.method === "GET" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (getFlowMatch) {
      const flowId = decodeURIComponent(getFlowMatch[1]);
      let flow: ReturnType<typeof dataStore.getFlow>;
      try {
        flow = dataStore.getFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      return new Response(JSON.stringify({ flow }), { headers: JSON_CORS_HEADERS });
    }

    // Polled by the side panel for a connection badge — the daemon's HTTP
    // server being reachable only proves this process is up; whether any
    // tool call (an MCP client's or the panel's own Run button) will
    // actually work depends on whether the extension's background worker
    // has a live WebSocket here (the `open`/`close` websocket handlers
    // below set/clear extensionSocket).
    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(
        JSON.stringify({ extensionConnected: extensionSocket != null, version: PACKAGE_VERSION }),
        { headers: JSON_CORS_HEADERS },
      );
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      try {
        const querySessionId = url.searchParams.get("sessionId") || SESSION_ID;
        const metrics = dataStore.getBenchmarkMetrics(querySessionId);
        return new Response(JSON.stringify(metrics), { headers: JSON_CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
    }

    const deleteMatch = req.method === "DELETE" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (deleteMatch) {
      const flowId = decodeURIComponent(deleteMatch[1]);
      let deleted: boolean;
      try {
        deleted = dataStore.deleteFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!deleted) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      return new Response(JSON.stringify({ success: true }), { headers: JSON_CORS_HEADERS });
    }

    const runMatch = req.method === "POST" ? url.pathname.match(/^\/flows\/([^/]+)\/run$/) : null;
    if (runMatch) {
      const flowId = decodeURIComponent(runMatch[1]);
      let flow: ReturnType<typeof dataStore.getFlow>;
      try {
        flow = dataStore.getFlow(flowId);
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS });
      }
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      if (!extensionSocket) {
        return new Response(JSON.stringify({ error: "Extension not connected", hint: "Open chrome://extensions, make sure BrowserControl Agent is enabled, and reload it." }), { status: 503, headers: JSON_CORS_HEADERS });
      }
      // The panel's Run button has no MCP session (no prior navigate), so
      // background.ts's dispatchCommand needs the flow's own domain to
      // auto-navigate there first if the current tab is on the wrong page
      // — see background.ts's run_flow/explore_flow handling.
      return executeCommand("run_flow", { steps: flow.steps, domain: flow.domain ?? undefined })
        .then((report) => new Response(JSON.stringify(report), { headers: JSON_CORS_HEADERS }))
        .catch((e) => new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS }));
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

/**
 * Relays one command to the extension over the WS bridge and waits for its
 * response. `timeoutMs` defaults to 15s (sized for CDP round trips);
 * stop_capture passes a longer one since it has to flush the MediaRecorder
 * and base64-encode a multi-MB blob before it can respond.
 */
async function executeCommand(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<CommandResult> {
  if (!extensionSocket) throw new Error("Extension not connected to Daemon. Open chrome://extensions and reload BrowserControl Agent.");

  const flowWarning = recordAndCheckFlow(cmd, args);
  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error("Timeout waiting for Chrome. The page may be stuck on a slow load or an unhandled dialog."));
    }, timeoutMs);

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
  // Logged by the internal action (click, navigate, ...) that ran, not the
  // gateway tool name that carried it — falls back to the tool name only
  // if `action` is missing (a malformed call).
  const { action: loggedAction, ...restArgs } = (request.params.arguments ?? {}) as Record<string, unknown>;
  const logCmd = typeof loggedAction === "string" && loggedAction ? loggedAction : request.params.name;
  logToolCall(LOG_FILE, logCmd, restArgs, response, Date.now() - start);
  return response;
});

async function runMcp() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("🚀 MCP Server is connected to stdio");
}

runMcp().catch((e) => console.error("MCP Server failed", e));

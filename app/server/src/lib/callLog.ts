// Tool-call logging — one JSONL line per call to data/logs/session-<id>.jsonl,
// which is what answers "which call burned the tokens" and what replay.ts
// replays. `logFile` is passed in per call (not module state) since it's
// derived from daemon.ts's SESSION_ID at startup.

import { appendFileSync } from "node:fs";
import type { ToolArgs, ToolCallResponse } from "./types.js";

export const PREVIEW_CHARS = 300;

interface CallLogEntry {
  ts: string;
  cmd: string;
  args: ToolArgs;
  durationMs: number;
  approxChars: number;
  approxTokens: number;
  hasImage: boolean;
  isError: boolean;
  source: string;
  preview: string;
  elementRole?: string;
  elementName?: string;
}

function writeCallLog(logFile: string, entry: CallLogEntry): void {
  try { appendFileSync(logFile, JSON.stringify(entry) + "\n"); } catch {}
  console.error(`[tool:${entry.source}] ${entry.cmd} ${entry.durationMs}ms ~${entry.approxTokens}tok${entry.hasImage ? ' [image]' : ''}${entry.isError ? ' ERROR' : ''}`);
}

/** Logs one MCP tool-call result. `name` is the internal action (click, navigate, ...), not the gateway tool name — see daemon.ts's CallToolRequestSchema handler. */
export function logToolCall(logFile: string, name: string, args: ToolArgs, response: ToolCallResponse, durationMs: number): void {
  let approxChars = 0;
  let hasImage = false;
  let text = "";
  for (const item of response?.content ?? []) {
    if (item.type === "text") { approxChars += item.text?.length ?? 0; text += item.text ?? ""; }
    if (item.type === "image") { approxChars += item.data?.length ?? 0; hasImage = true; }
  }
  // click/type responses carry {role, name} (see background.ts's
  // getAxInfoForNode) so replay can re-resolve "the button named X" against
  // a fresh snapshot instead of trusting a backendDOMNodeId that goes stale
  // the moment the page reloads. Best-effort parse — `text` is whatever
  // JSON.stringify produced for the raw command result.
  let elementRole: string | undefined, elementName: string | undefined;
  try {
    const parsed = JSON.parse(text) as { role?: string; name?: string };
    elementRole = parsed?.role;
    elementName = parsed?.name;
  } catch {}
  writeCallLog(logFile, {
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

/** Logs one direct `/execute` HTTP call (replay.ts and similar) — same log file, source:"execute" to distinguish from MCP-originated calls. */
export function logDirectCall(logFile: string, cmd: string | undefined, args: ToolArgs, response: Record<string, unknown> | undefined, durationMs: number): void {
  const json = JSON.stringify(response ?? {});
  const data = response?.data as { role?: string; name?: string } | undefined;
  writeCallLog(logFile, {
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

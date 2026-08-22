import { appendFileSync } from "node:fs";
import { BenchmarkEngine } from "@browsercontrol/benchmark";
import type { ToolArgs, ToolCallResponse } from "../../libs/types.js";
import { recordToolCallDetail } from "../dataStore/index.js";
import { PREVIEW_CHARS } from "./constants.js";
import type { CallLogEntry } from "./types.js";

export { PREVIEW_CHARS } from "./constants.js";
export type { CallLogEntry } from "./types.js";

function parseSessionId(logFile: string): string {
  const match = logFile.match(/session-([^/\\.]+)\.jsonl/);
  return match?.[1] ?? "current";
}

function writeCallLog(logFile: string, entry: CallLogEntry): void {
  try {
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {}
  console.error(
    `[tool:${entry.source}] ${entry.cmd} ${entry.durationMs}ms ~${entry.inTokens}in/${entry.outTokens}out tok${entry.hasImage ? " [image]" : ""}${entry.isError ? " ERROR" : ""}`,
  );

  const stepCount = Array.isArray(entry.args?.steps) ? entry.args.steps.length : 0;
  const mem = BenchmarkEngine.isEnabled() ? BenchmarkEngine.sampleServerMemory() : undefined;

  recordToolCallDetail({
    sessionId: parseSessionId(logFile),
    cmd: entry.cmd,
    args: entry.args ?? {},
    durationMs: entry.durationMs,
    inChars: entry.inChars,
    inTokens: entry.inTokens,
    outChars: entry.outChars,
    outTokens: entry.outTokens,
    approxChars: entry.approxChars,
    approxTokens: entry.approxTokens,
    hasImage: entry.hasImage,
    isError: entry.isError,
    source: entry.source,
    preview: entry.preview,
    elementRole: entry.elementRole,
    elementName: entry.elementName,
    stepCount,
    createdAt: Date.now(),
    bunRssMb: mem?.rssMb,
    bunHeapUsedMb: mem?.heapUsedMb,
    bunHeapTotalMb: mem?.heapTotalMb,
  });
}

/** Logs one MCP tool-call result. `name` is the internal action (click, navigate, ...), not the gateway tool name — see daemon.ts's CallToolRequestSchema handler. */
export function logToolCall(
  logFile: string,
  name: string,
  args: ToolArgs,
  response: ToolCallResponse,
  durationMs: number,
): void {
  const argsJson = JSON.stringify(args ?? {});
  const inChars = name.length + argsJson.length;
  const inTokens = Math.max(1, Math.round(inChars / 4));

  let outChars = 0;
  let hasImage = false;
  let text = "";
  for (const item of response?.content ?? []) {
    if (item.type === "text") {
      outChars += item.text?.length ?? 0;
      text += item.text ?? "";
    }
    if (item.type === "image") {
      outChars += item.data?.length ?? 0;
      hasImage = true;
    }
  }
  const outTokens = Math.max(1, Math.round(outChars / 4));

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
    inChars,
    inTokens,
    outChars,
    outTokens,
    approxChars: inChars + outChars,
    approxTokens: inTokens + outTokens,
    hasImage,
    isError: response?.isError === true,
    source: "mcp",
    preview: text.slice(0, PREVIEW_CHARS),
    elementRole,
    elementName,
  });
}

/** Logs one direct `/execute` HTTP call (replay.ts and similar) — same log file, source:"execute" to distinguish from MCP-originated calls. */
export function logDirectCall(
  logFile: string,
  cmd: string | undefined,
  args: ToolArgs,
  response: Record<string, unknown> | undefined,
  durationMs: number,
): void {
  const cmdName = cmd ?? "unknown";
  const argsJson = JSON.stringify(args ?? {});
  const inChars = cmdName.length + argsJson.length;
  const inTokens = Math.max(1, Math.round(inChars / 4));

  const json = JSON.stringify(response ?? {});
  const outChars = json.length;
  const outTokens = Math.max(1, Math.round(outChars / 4));

  const data = response?.data as { role?: string; name?: string } | undefined;
  writeCallLog(logFile, {
    ts: new Date().toISOString(),
    cmd: cmdName,
    args,
    durationMs,
    inChars,
    inTokens,
    outChars,
    outTokens,
    approxChars: inChars + outChars,
    approxTokens: inTokens + outTokens,
    hasImage: false,
    elementRole: data?.role,
    elementName: data?.name,
    isError: response?.type === "error" || !!response?.error,
    source: "execute",
    preview: json.slice(0, PREVIEW_CHARS),
  });
}

// Replays a recorded data/logs/session-<ts>.jsonl file against a live
// daemon — re-runs the exact same sequence of tool calls to reproduce a
// flow (a bug, a demo, a regression check) without needing an LLM agent to
// re-derive it.
//
// Usage:
//   bun run src/replay.ts --list
//   bun run src/replay.ts data/logs/session-1785812707974.jsonl [--continue] [--delay 500]
//
// Requires the daemon to already be running (spawned by an MCP client, or
// `bun run src/server/daemon.ts` in another terminal) with the extension
// connected — this talks to its existing /execute HTTP endpoint, it doesn't
// start one.
//
// Node id resolution: backendDOMNodeId is only stable within one page's DOM
// — a fresh navigate reassigns them all. Logs that carry {role, name} on
// click/type get re-resolved against a fresh snapshot by identity instead of
// trusting the recorded id (warns if ambiguous or missing); older logs fall
// back to the raw id, a coin flip after any navigate.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionResponse } from "@browsercontrol/shared";

// Moved under data/ (used to be a top-level logs/ dir) — daemon.ts
// migrates any legacy logs/*.jsonl into the new location on startup, but
// replay can run without the daemon ever having been started against this
// checkout, so fall back to the legacy path if the new one doesn't exist.
const NEW_LOGS_DIR = join(import.meta.dir, "..", "..", "..", "data", "logs");
const LEGACY_LOGS_DIR = join(import.meta.dir, "..", "..", "..", "logs");
const LOGS_DIR = existsSync(NEW_LOGS_DIR) ? NEW_LOGS_DIR : LEGACY_LOGS_DIR;
const DAEMON_URL = "http://127.0.0.1:8765/execute";

// A logged JSONL line from daemon.ts's writeCallLog — replay only reads
// these four fields, everything else in a real log entry is ignored.
interface LogEntry {
  cmd: string;
  args?: Record<string, unknown>;
  elementRole?: string;
  elementName?: string;
}

// The compact shape browser_inspect's snapshot/visual_snapshot actions
// return per element (see background.ts's toCompactEntry) — i=nodeId,
// r=role, n=name.
interface SnapshotNode {
  i?: number;
  r?: string;
  n?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function listSessions(): void {
  let files: string[];
  try {
    files = readdirSync(LOGS_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    console.log(
      "No logs/ directory yet — run a session through the MCP tools first.",
    );
    return;
  }
  if (files.length === 0) {
    console.log("No session logs found in logs/.");
    return;
  }
  files.sort();
  for (const f of files) {
    const full = join(LOGS_DIR, f);
    const lineCount = readFileSync(full, "utf8")
      .split("\n")
      .filter(Boolean).length;
    console.log(
      `${f}  (${lineCount} calls, ${(statSync(full).size / 1024).toFixed(1)} KB)`,
    );
  }
}

async function execute(cmd: string, args: Record<string, unknown>): Promise<Partial<ExtensionResponse>> {
  const res = await fetch(DAEMON_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, ...args }),
  });
  return res.json() as Promise<Partial<ExtensionResponse>>;
}

// backendDOMNodeId only means something within one page's DOM — a fresh
// navigate reassigns them all, so replaying an old click's raw id is a
// coin flip at best (see the header comment). role+name survive a reload
// because they reflect the page's actual content. When a logged entry has
// them (background.ts's getAxInfoForNode attaches these to every click/type
// response), re-resolve against a fresh snapshot instead of trusting the
// recorded id.
async function resolveNodeIdByIdentity(role: string, name: string): Promise<{ nodeId: number; ambiguous: boolean } | null> {
  const snap = await execute("snapshot", {});
  const data = snap?.data as { nodes?: SnapshotNode[] } | undefined;
  const nodes = data?.nodes ?? [];
  const candidates = nodes.filter((n) => n.r === role && n.n === name);
  if (candidates.length === 0 || candidates[0].i == null) return null;
  return { nodeId: candidates[0].i, ambiguous: candidates.length > 1 };
}

async function replay(
  logPath: string,
  opts: { continueOnError: boolean; delayMs: number },
): Promise<void> {
  const resolvedPath =
    logPath.startsWith("logs/") ||
    logPath.startsWith("data/logs/") ||
    logPath.includes(":") ||
    logPath.startsWith("/")
      ? logPath
      : join(LOGS_DIR, logPath);

  const lines = readFileSync(resolvedPath, "utf8").split("\n").filter(Boolean);
  console.log(`Replaying ${lines.length} call(s) from ${resolvedPath}\n`);

  let failures = 0;
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]) as LogEntry;
    // Logged cmd is already the internal extension command (click,
    // navigate, ...) the daemon's HTTP relay expects — daemon.ts logs by
    // action, not by the browser_act/browser_inspect/... gateway tool name
    // that carried it (see its CallToolRequestSchema handler). The
    // "browser_" strip below is now a no-op kept only for old log files
    // recorded before the gateway-tool refactor, whose cmd field still has
    // the pre-refactor per-action MCP tool name (browser_click, ...).
    const cmd = String(entry.cmd).replace(/^browser_/, "");
    let args: Record<string, unknown> = entry.args ?? {};

    if ((cmd === "click" || cmd === "type") && args.nodeId && entry.elementRole && entry.elementName) {
      try {
        const resolved = await resolveNodeIdByIdentity(entry.elementRole, entry.elementName);
        if (resolved) {
          if (resolved.nodeId !== args.nodeId) {
            console.log(`  (resolved ${entry.elementRole} "${entry.elementName}": logged id ${args.nodeId} -> current id ${resolved.nodeId})`);
          }
          if (resolved.ambiguous) {
            console.log(`  (WARNING: multiple elements matched ${entry.elementRole} "${entry.elementName}" — used the first; verify this is the right one)`);
          }
          args = { ...args, nodeId: resolved.nodeId };
        } else {
          console.log(`  (WARNING: no element matched ${entry.elementRole} "${entry.elementName}" on the current page — falling back to logged id ${args.nodeId}, likely stale)`);
        }
      } catch (e: unknown) {
        console.log(`  (identity resolution failed: ${errorMessage(e)} — falling back to logged id ${args.nodeId})`);
      }
    }

    process.stdout.write(
      `[${i + 1}/${lines.length}] ${cmd} ${JSON.stringify(args)} ... `,
    );
    try {
      const res = await fetch(DAEMON_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, ...args }),
      });
      const data = await res.json() as Partial<ExtensionResponse> & { data?: { error?: string } };
      // A WebSocket-level failure has a top-level `error`; a *handled*
      // failure (e.g. click's "Failed to resolve node bounds") is
      // type:"result" with the error nested one level deeper in `data.data`
      // — checking only the top-level field missed that far more common
      // case, so every failed click/type used to log as "ok".
      const innerError = data?.data?.error;
      const failed = !res.ok || data?.type === "error" || data?.error || innerError;
      if (failed) {
        failures++;
        const reason = data?.error ?? innerError ?? JSON.stringify(data).slice(0, 200);
        console.log(`FAILED (${res.status}) ${reason}`);
        if (!opts.continueOnError) {
          console.log(
            "\nStopping at first failure. Pass --continue to replay through errors.",
          );
          process.exit(1);
        }
      } else {
        console.log("ok");
      }
    } catch (e: unknown) {
      failures++;
      console.log(`FAILED (connection error: ${errorMessage(e)})`);
      console.log(
        "Is the daemon running with the extension connected? (bun run src/server/daemon.ts)",
      );
      if (!opts.continueOnError) process.exit(1);
    }

    if (opts.delayMs > 0 && i < lines.length - 1) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }

  console.log(
    `\nReplay complete: ${lines.length - failures}/${lines.length} succeeded.`,
  );
  if (failures > 0) process.exit(1);
}

const argv = process.argv.slice(2);
// Default delay is NOT 0 — replay exists to be watched, unlike a live agent
// session where speed matters. A bare `--delay` with no number (easy to
// type by mistake) falls back to the same default rather than silently
// becoming 0 and blowing through the whole log in a few seconds.
const DEFAULT_DELAY_MS = 400;

function parseDelay(argv: string[]): number {
  const eqArg = argv.find((a) => a.startsWith("--delay="));
  if (eqArg) {
    const n = parseInt(eqArg.slice("--delay=".length), 10);
    return Number.isFinite(n) ? n : DEFAULT_DELAY_MS;
  }
  const idx = argv.indexOf("--delay");
  if (idx === -1) return DEFAULT_DELAY_MS;
  const n = parseInt(argv[idx + 1], 10);
  return Number.isFinite(n) ? n : DEFAULT_DELAY_MS;
}

if (argv.includes("--list") || argv.length === 0) {
  listSessions();
} else {
  const logPath = argv[0];
  const continueOnError = argv.includes("--continue");
  const delayMs = parseDelay(argv);
  console.log(
    `(delay between steps: ${delayMs}ms — pass --delay 0 for no pause, or --delay=N)`,
  );
  await replay(logPath, { continueOnError, delayMs });
}

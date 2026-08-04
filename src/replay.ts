// Replays a recorded logs/session-<ts>.jsonl file against a live daemon —
// re-runs the exact same sequence of tool calls to reproduce a flow (a bug,
// a demo, a regression check) without needing an LLM agent to re-derive it.
//
// Usage:
//   bun run src/replay.ts --list
//   bun run src/replay.ts logs/session-1785812707974.jsonl [--continue] [--delay 500]
//
// Requires the daemon to already be running (spawned by an MCP client, or
// `bun run src/daemon.ts` in another terminal) with the extension connected
// — this talks to its existing /execute HTTP endpoint, it doesn't start one.
//
// Node id resolution: backendDOMNodeId is only stable within one page's
// DOM — a fresh navigate reassigns them all. For logs recorded after
// background.ts started attaching {role, name} to click/type responses,
// this re-resolves each click/type against a fresh snapshot by identity
// (role+name) instead of trusting the recorded id, and warns if the match
// is ambiguous (multiple elements with the same role+name) or missing
// entirely. Older logs without that data fall back to the raw id — which
// remains a coin flip after any navigate, and will typically fail loudly
// now (see the FAILED output) rather than silently clicking the wrong
// thing, since the earlier "any 200 response counts as ok" check was
// itself a bug (fixed — see below).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = join(import.meta.dir, "..", "logs");
const DAEMON_URL = "http://127.0.0.1:8765/execute";

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

async function execute(cmd: string, args: any): Promise<any> {
  const res = await fetch(DAEMON_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, ...args }),
  });
  return res.json();
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
  const nodes: any[] = snap?.data?.nodes ?? [];
  const candidates = nodes.filter((n) => n.r === role && n.n === name);
  if (candidates.length === 0) return null;
  return { nodeId: candidates[0].i, ambiguous: candidates.length > 1 };
}

async function replay(
  logPath: string,
  opts: { continueOnError: boolean; delayMs: number },
): Promise<void> {
  const resolvedPath =
    logPath.startsWith("logs/") ||
    logPath.includes(":") ||
    logPath.startsWith("/")
      ? logPath
      : join(LOGS_DIR, logPath);

  const lines = readFileSync(resolvedPath, "utf8").split("\n").filter(Boolean);
  console.log(`Replaying ${lines.length} call(s) from ${resolvedPath}\n`);

  let failures = 0;
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);
    // Logged cmd is the MCP tool name (browser_click); the daemon's HTTP
    // relay expects the internal extension command (click) — every tool
    // maps to its internal command by dropping the "browser_" prefix 1:1,
    // with args passed through unchanged (see daemon.ts's handleToolCall).
    const cmd = String(entry.cmd).replace(/^browser_/, "");
    let args = entry.args ?? {};

    if ((cmd === "click" || cmd === "type") && args.nodeId && entry.elementRole) {
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
      } catch (e: any) {
        console.log(`  (identity resolution failed: ${e.message} — falling back to logged id ${args.nodeId})`);
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
      const data = await res.json();
      // The extension always wraps its response as {id, type, data}. A
      // WebSocket-level failure (dispatchCommand threw) shows up as
      // type:"error" with a top-level `error` string. A *handled* failure
      // (e.g. click's "Failed to resolve node bounds") is type:"result"
      // with the error one level deeper, inside `data.data`. Checking only
      // the top-level `error` field missed that second, far more common
      // case entirely — every failed click/type was silently logged as
      // "ok" because of this.
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
    } catch (e: any) {
      failures++;
      console.log(`FAILED (connection error: ${e.message})`);
      console.log(
        "Is the daemon running with the extension connected? (bun run src/daemon.ts)",
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

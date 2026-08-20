// Human-facing housekeeping over data/index.sqlite — status/sessions/show/
// read/search are pure reads; rename is a one-row update; gc is the ONLY
// thing here that deletes anything, and only when the caller passes an
// explicit filter (--session/--older-than/--keep-last) AND --yes. Nothing
// in the daemon itself ever calls dataStore.deleteSessions — this script is
// the sole entry point for that, by design (see dataStore.ts's header).
//
// Usage:
//   bun run src/server/dataCli.ts status
//   bun run src/server/dataCli.ts sessions [--limit N]
//   bun run src/server/dataCli.ts show <sessionId>
//   bun run src/server/dataCli.ts read <blockId>
//   bun run src/server/dataCli.ts search <query> [--session <id>] [--limit N]
//   bun run src/server/dataCli.ts rename <sessionId> <name...>
//   bun run src/server/dataCli.ts gc (--session <id> | --older-than <Nd> | --keep-last <N>) [--yes]

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as dataStore from "./lib/dataStore.js";

const DATA_DIR = join(import.meta.dir, "..", "..", "data");

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function fmtDuration(startMs: number, endMs: number | null): string {
  const end = endMs ?? Date.now();
  const s = Math.max(0, Math.round((end - startMs) / 1000));
  if (s < 60) return `${s}s${endMs == null ? " (running)" : ""}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s${endMs == null ? " (running)" : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m${endMs == null ? " (running)" : ""}`;
}

/** log artifacts don't cache size_bytes (see dataStore.ts) — stat them live for an accurate total instead of trusting a value that would've gone stale the moment it was written. */
function liveArtifactSize(a: { path: string; sizeBytes: number | null }): number {
  if (a.sizeBytes != null) return a.sizeBytes;
  try {
    return statSync(a.path).size;
  } catch {
    return 0;
  }
}

function cmdStatus(): void {
  const sessions = dataStore.listSessions({ limit: 100000 });
  let images = 0, videos = 0, logBytes = 0, imageBytes = 0, videoBytes = 0;
  let docsBlocks = 0, docsChars = 0;
  for (const s of sessions) {
    docsBlocks += s.docsBlocks;
    docsChars += s.docsChars;
  }
  // Per-session detail is needed for real byte totals (listSessions only
  // aggregates counts) — fine at CLI scale, this isn't a hot path.
  for (const s of sessions) {
    const detail = dataStore.getSessionDetail(s.id);
    if (!detail) continue;
    for (const a of detail.artifacts) {
      const size = liveArtifactSize(a);
      if (a.kind === "image") { images++; imageBytes += size; }
      else if (a.kind === "video") { videos++; videoBytes += size; }
      else if (a.kind === "log") { logBytes += size; }
    }
  }
  console.log(`Sessions: ${sessions.length}`);
  console.log(`  Logs:      ${fmtBytes(logBytes)}`);
  console.log(`  Images:    ${images} (${fmtBytes(imageBytes)})`);
  console.log(`  Videos:    ${videos} (${fmtBytes(videoBytes)})`);
  console.log(`  Docs:      ${docsBlocks} block(s), ${docsChars.toLocaleString()} chars`);
  console.log(`  Index DB:  ${fmtBytes(dataStore.dbFileSizeBytes())} (data/index.sqlite)`);
  try {
    const legacyDocs = join(DATA_DIR, "docs");
    const legacy = readdirSync(legacyDocs).filter((f) => f.endsWith(".md"));
    if (legacy.length > 0) {
      console.log(
        `\nNote: ${legacy.length} legacy data/docs/*.md file(s) from before this tool existed — not indexed, not written to anymore, safe to delete manually once confirmed unneeded.`,
      );
    }
  } catch {}
}

function cmdSessions(limit: number): void {
  const sessions = dataStore.listSessions({ limit });
  if (sessions.length === 0) {
    console.log("No sessions recorded yet.");
    return;
  }
  for (const s of sessions) {
    console.log(
      `${s.id}  ${fmtDate(s.startedAt)}  ${fmtDuration(s.startedAt, s.endedAt).padEnd(14)} calls:${s.toolCalls}  img:${s.images} vid:${s.videos} docs:${s.docsBlocks}(${s.docsChars}c)  ${s.name ? `— ${s.name}` : "(unnamed)"}`,
    );
  }
}

function cmdShow(sessionId: string): void {
  const d = dataStore.getSessionDetail(sessionId);
  if (!d) {
    console.log(`No session with id "${sessionId}". Run \`sessions\` to list known ids.`);
    return;
  }
  console.log(`Session ${d.id}${d.name ? ` — ${d.name}` : ""}`);
  console.log(`  Started: ${fmtDate(d.startedAt)}  Duration: ${fmtDuration(d.startedAt, d.endedAt)}  Tool calls: ${d.toolCalls}`);
  if (d.hosts.length > 0) console.log(`  Hosts: ${d.hosts.join(", ")}`);
  console.log(`\n  Artifacts (${d.artifacts.length}):`);
  for (const a of d.artifacts) {
    console.log(`    [${a.kind}] ${a.path} (${fmtBytes(liveArtifactSize(a))}) — ${fmtDate(a.createdAt)}`);
  }
  console.log(`\n  Docs blocks (${d.docBlockList.length}):`);
  for (const b of d.docBlockList) {
    console.log(`    #${b.id} ${b.title ?? b.source} — ${b.charCount} chars — ${fmtDate(b.createdAt)}`);
  }
}

function cmdRead(blockId: number): void {
  const block = dataStore.getDocsBlock(blockId);
  if (!block) {
    console.log(`No docs block with id ${blockId}.`);
    return;
  }
  console.log(`# Block ${block.id} — ${block.title ?? block.source}`);
  console.log(`(session ${block.sessionId}, ${block.charCount} chars, ${fmtDate(block.createdAt)})\n`);
  console.log(block.content);
}

function cmdSearch(query: string, sessionId: string | undefined, limit: number): void {
  const results = dataStore.searchDocsBlocks(query, { sessionId, limit });
  if (results.length === 0) {
    console.log(`No matches for "${query}".`);
    return;
  }
  for (const r of results) {
    console.log(`#${r.id} [session ${r.sessionId}] ${r.title ?? r.source}`);
    console.log(`    ${r.snippet.replace(/\s+/g, " ").trim()}`);
  }
}

function cmdRename(sessionId: string, name: string): void {
  dataStore.setSessionName(sessionId, name);
  console.log(`Session ${sessionId} renamed to "${name}".`);
}

function parseOlderThanDays(spec: string): number {
  const m = /^(\d+)d?$/.exec(spec.trim());
  if (!m) throw new Error(`Invalid --older-than value "${spec}" — expected a number of days, e.g. 14 or 14d.`);
  return Number(m[1]);
}

function cmdGc(argv: string[]): void {
  const sessionFlag = flagValue(argv, "--session");
  const olderThanFlag = flagValue(argv, "--older-than");
  const keepLastFlag = flagValue(argv, "--keep-last");
  const yes = argv.includes("--yes");

  const filtersGiven = [sessionFlag, olderThanFlag, keepLastFlag].filter((v) => v != null).length;
  if (filtersGiven === 0) {
    console.log(
      "gc requires an explicit filter — nothing is deleted implicitly. Pass one of:\n" +
      "  --session <id>        delete one specific session\n" +
      "  --older-than <Nd>      delete sessions started more than N days ago\n" +
      "  --keep-last <N>        delete every session except the N most recent\n" +
      "Add --yes to actually delete (omit it to preview first).",
    );
    process.exitCode = 1;
    return;
  }
  if (filtersGiven > 1) {
    console.log("Pass exactly one of --session / --older-than / --keep-last, not several at once.");
    process.exitCode = 1;
    return;
  }

  const all = dataStore.listSessions({ limit: 1000000 });
  let targets: dataStore.SessionSummary[];
  if (sessionFlag) {
    targets = all.filter((s) => s.id === sessionFlag);
    if (targets.length === 0) {
      console.log(`No session with id "${sessionFlag}".`);
      return;
    }
  } else if (olderThanFlag) {
    const days = parseOlderThanDays(olderThanFlag);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    targets = all.filter((s) => s.startedAt < cutoff);
  } else {
    const keep = Number(keepLastFlag);
    if (!Number.isFinite(keep) || keep < 0) {
      console.log(`Invalid --keep-last value "${keepLastFlag}".`);
      process.exitCode = 1;
      return;
    }
    // listSessions is already newest-first.
    targets = all.slice(keep);
  }

  if (targets.length === 0) {
    console.log("No sessions match — nothing to do.");
    return;
  }

  let totalBytes = 0;
  for (const s of targets) {
    const detail = dataStore.getSessionDetail(s.id);
    if (!detail) continue;
    for (const a of detail.artifacts) totalBytes += liveArtifactSize(a);
  }

  console.log(`${yes ? "Deleting" : "Would delete"} ${targets.length} session(s), ~${fmtBytes(totalBytes)} total:`);
  for (const s of targets) {
    console.log(`  ${s.id}  ${fmtDate(s.startedAt)}  ${s.name ? `— ${s.name}` : "(unnamed)"}`);
  }

  if (!yes) {
    console.log("\nDry run — nothing deleted. Re-run with --yes to actually delete.");
    return;
  }

  const summary = dataStore.deleteSessions(targets.map((s) => s.id));
  console.log(
    `\nDeleted ${summary.deletedSessions} session(s), ${summary.deletedFiles} file(s), freed ${fmtBytes(summary.freedBytes)}.`,
  );
  if (summary.errors.length > 0) {
    console.log(`${summary.errors.length} file(s) could not be deleted:`);
    for (const e of summary.errors) console.log(`  ${e}`);
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx === argv.length - 1) return undefined;
  return argv[idx + 1];
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

switch (cmd) {
  case "status":
    cmdStatus();
    break;
  case "sessions":
    cmdSessions(Number(flagValue(rest, "--limit")) || 50);
    break;
  case "show":
    if (!rest[0]) console.log("Usage: dataCli.ts show <sessionId>");
    else cmdShow(rest[0]);
    break;
  case "read":
    if (!rest[0] || !Number.isFinite(Number(rest[0]))) console.log("Usage: dataCli.ts read <blockId>");
    else cmdRead(Number(rest[0]));
    break;
  case "search": {
    const nonFlagArgs = rest.filter((a, i) => a !== "--session" && a !== "--limit" && rest[i - 1] !== "--session" && rest[i - 1] !== "--limit");
    const query = nonFlagArgs.join(" ");
    if (!query) console.log("Usage: dataCli.ts search <query> [--session <id>] [--limit N]");
    else cmdSearch(query, flagValue(rest, "--session"), Number(flagValue(rest, "--limit")) || 20);
    break;
  }
  case "rename":
    if (!rest[0] || rest.length < 2) console.log("Usage: dataCli.ts rename <sessionId> <name...>");
    else cmdRename(rest[0], rest.slice(1).join(" "));
    break;
  case "gc":
    cmdGc(rest);
    break;
  default:
    console.log(
      "Usage: bun run src/server/dataCli.ts <status|sessions|show|read|search|rename|gc> [...args]\n" +
      "See the header comment in src/server/dataCli.ts for full usage per command.",
    );
    process.exitCode = cmd ? 1 : 0;
}

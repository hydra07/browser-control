/**
 * SQLite index over data/ — the missing "which session made this, is it
 * safe to delete, can I search it" layer. Deliberately NOT a replacement
 * for the on-disk log/image/video files (replay.ts still reads JSONL
 * directly, screenshots/recordings stay real files) — this only indexes
 * them, plus becomes the new home for crawled/extracted content that used
 * to live in one ever-growing data/docs/docs-<ts>.md per session (see
 * addDocsBlock below).
 *
 * No auto-deletion lives here or anywhere in the daemon — deleteSessions()
 * exists for dataCli.ts's `gc` command, which requires an explicit filter
 * from a human before it's ever called. The daemon itself only ever reads
 * and appends.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import type { FlowStep } from "@browsercontrol/shared";
import { DATA_DIR, DB_PATH } from "../../configs/paths.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { HOSTS_NAME_SHOW_CAP, HOSTS_STORE_CAP } from "./constants.js";
import type {
  BenchmarkMetrics,
  DeleteSummary,
  DocsBlockFull,
  DocsBlockMeta,
  DocsBlockResult,
  DocsBlockRow,
  DocsSearchResult,
  FlowFull,
  FlowMeta,
  FlowRow,
  RecordArtifactInput,
  SessionDetail,
  SessionSummary,
  ToolCallRecordInput,
} from "./types.js";

export * from "./types.js";

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
/**
 * Without this, a writer (a tool call recording an artifact/session row)
 * and a reader (the side panel's GET /flows poll, every 5s) landing on the
 * same millisecond throw SQLITE_BUSY immediately instead of waiting a beat
 * — which surfaced as the daemon looking intermittently "unreachable" from
 * the extension even though the process was up the whole time. 5s covers
 * any write this module does; WAL readers rarely contend this long.
 */
db.exec("PRAGMA busy_timeout = 5000");

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    name TEXT,
    name_is_custom INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    hosts_json TEXT NOT NULL DEFAULT '[]'
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT,
    size_bytes INTEGER,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)`);
db.run(`
  CREATE TABLE IF NOT EXISTS docs_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_docs_session ON docs_blocks(session_id)`);

/**
 * A standalone (not external-content) FTS5 table — duplicates the text
 * rather than linking back to docs_blocks by rowid, which costs roughly 2x
 * storage for docs content but means delete-by-session is one plain DELETE
 * instead of external-content-table bookkeeping. Given the "keep
 * everything" retention policy, the simpler table is worth the extra disk.
 * Guarded: some Bun/SQLite builds may lack FTS5, so search falls back to a
 * LIKE scan over docs_blocks if this table never gets created.
 */
let ftsAvailable = true;
try {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      content, source, title,
      session_id UNINDEXED, block_id UNINDEXED, created_at UNINDEXED
    )
  `);
} catch (e) {
  ftsAvailable = false;
  console.error("[dataStore] FTS5 unavailable, docs search will fall back to a plain LIKE scan:", errorMessage(e));
}

/**
 * Saved browser_act run_flow step sequences — durable, reusable knowledge
 * (same category as skills/), not scoped to a session_id: the side panel
 * is browser-side and outlives any one daemon session, so it needs to list
 * flows regardless of which session saved them.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    domain TEXT,
    steps_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    cmd TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '{}',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    in_chars INTEGER NOT NULL DEFAULT 0,
    in_tokens INTEGER NOT NULL DEFAULT 0,
    out_chars INTEGER NOT NULL DEFAULT 0,
    out_tokens INTEGER NOT NULL DEFAULT 0,
    approx_chars INTEGER NOT NULL DEFAULT 0,
    approx_tokens INTEGER NOT NULL DEFAULT 0,
    has_image INTEGER NOT NULL DEFAULT 0,
    is_error INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'mcp',
    preview TEXT,
    element_role TEXT,
    element_name TEXT,
    step_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);
try {
  db.run(`ALTER TABLE tool_calls ADD COLUMN in_chars INTEGER DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE tool_calls ADD COLUMN in_tokens INTEGER DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE tool_calls ADD COLUMN out_chars INTEGER DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE tool_calls ADD COLUMN out_tokens INTEGER DEFAULT 0`);
} catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tool_calls_cmd ON tool_calls(cmd)`);

function formatAutoName(hosts: string[]): string {
  if (hosts.length === 0) return "";
  const shown = hosts.slice(0, HOSTS_NAME_SHOW_CAP);
  const rest = hosts.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

export function initSession(id: string, opts: { pid?: number } = {}): void {
  db.query(`INSERT OR IGNORE INTO sessions (id, started_at, pid) VALUES (?, ?, ?)`).run(
    id,
    Date.now(),
    opts.pid ?? null,
  );
}

/** Best-effort — called on SIGINT/SIGTERM so `sessions.ended_at` reflects a clean shutdown rather than staying NULL forever. */
export function endSession(id: string): void {
  try {
    db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(Date.now(), id);
  } catch {}
}

export function recordToolCall(sessionId: string): void {
  try {
    db.query(`UPDATE sessions SET tool_calls = tool_calls + 1 WHERE id = ?`).run(sessionId);
  } catch {}
}

/** Dedups into hosts_json (capped) and, unless the session has a custom name, recomputes `name` from the visited-hostname list — the zero-effort default a session gets without anyone calling browser_session's set_session_name action. */
export function recordHostVisit(sessionId: string, hostname: string): void {
  if (!hostname) return;
  try {
    const row = db.query(`SELECT hosts_json, name_is_custom FROM sessions WHERE id = ?`).get(sessionId) as
      | { hosts_json: string; name_is_custom: number }
      | undefined;
    if (!row) return;
    let hosts: string[] = [];
    try {
      hosts = JSON.parse(row.hosts_json);
    } catch {}
    if (!hosts.includes(hostname)) {
      hosts.push(hostname);
      if (hosts.length > HOSTS_STORE_CAP) hosts = hosts.slice(0, HOSTS_STORE_CAP);
    }
    if (row.name_is_custom) {
      db.query(`UPDATE sessions SET hosts_json = ? WHERE id = ?`).run(JSON.stringify(hosts), sessionId);
    } else {
      db.query(`UPDATE sessions SET hosts_json = ?, name = ? WHERE id = ?`).run(
        JSON.stringify(hosts),
        formatAutoName(hosts),
        sessionId,
      );
    }
  } catch {}
}

/** Explicit override — sets name_is_custom so recordHostVisit stops touching `name`. Used by browser_session's set_session_name action and dataCli.ts's `rename`. */
export function setSessionName(sessionId: string, name: string): void {
  db.query(`UPDATE sessions SET name = ?, name_is_custom = 1 WHERE id = ?`).run(name, sessionId);
}

export function recordArtifact(input: RecordArtifactInput): number {
  const result = db
    .query(`INSERT INTO artifacts (session_id, kind, path, source, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      input.sessionId,
      input.kind,
      input.path,
      input.source ?? null,
      input.sizeBytes ?? null,
      input.createdAt ?? Date.now(),
    );
  return Number(result.lastInsertRowid);
}

function metaFromRow(row: DocsBlockRow): DocsBlockMeta {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    title: row.title,
    charCount: row.char_count,
    createdAt: row.created_at,
  };
}

/**
 * The replacement for the old docs.ts's appendContentToDocsFile — one row
 * per call instead of one more chunk glued onto a single ever-growing
 * per-session markdown file. `source` is a short label (a URL, a selector,
 * "job task: <url>") describing where this content came from; browse it via
 * listDocsBlocks/searchDocsBlocks/getDocsBlock (browser_knowledge's query_docs), not by
 * reading a file path.
 */
export function addDocsBlock(sessionId: string, content: string, source: string, title?: string): DocsBlockResult {
  const charCount = content.length;
  const createdAt = Date.now();
  const result = db
    .query(
      `INSERT INTO docs_blocks (session_id, source, title, content, char_count, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, source, title ?? null, content, charCount, createdAt);
  const blockId = Number(result.lastInsertRowid);
  if (ftsAvailable) {
    try {
      db.query(
        `INSERT INTO docs_fts (content, source, title, session_id, block_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(content, source, title ?? "", sessionId, blockId, createdAt);
    } catch (e) {
      console.error("[dataStore] docs_fts insert failed (search index may be incomplete):", errorMessage(e));
    }
  }
  const totalRow = db
    .query(`SELECT COALESCE(SUM(char_count), 0) as total FROM docs_blocks WHERE session_id = ?`)
    .get(sessionId) as { total: number };
  return { blockId, charCount, sessionTotalChars: totalRow.total };
}

/** Metadata only (id, source, title, charCount, createdAt) — same "cheap list, fetch detail separately" shape as browser_knowledge's list_skills / browser_inspect's snapshot. */
export function listDocsBlocks(opts: { sessionId?: string; limit?: number } = {}): DocsBlockMeta[] {
  const limit = opts.limit ?? 50;
  const rows = (
    opts.sessionId
      ? db
          .query(
            `SELECT id, session_id, source, title, char_count, created_at FROM docs_blocks WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(opts.sessionId, limit)
      : db
          .query(
            `SELECT id, session_id, source, title, char_count, created_at FROM docs_blocks ORDER BY id DESC LIMIT ?`,
          )
          .all(limit)
  ) as DocsBlockRow[];
  return rows.map(metaFromRow);
}

export function getDocsBlock(id: number): DocsBlockFull | undefined {
  const row = db
    .query(`SELECT id, session_id, source, title, content, char_count, created_at FROM docs_blocks WHERE id = ?`)
    .get(id) as (DocsBlockRow & { content: string }) | undefined;
  if (!row) return undefined;
  return { ...metaFromRow(row), content: row.content };
}

function likeSnippet(content: string, query: string, radius = 60): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + query.length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

/** FTS5 MATCH + snippet() when available; falls back to a plain LIKE scan over docs_blocks (both on ftsAvailable:false and on a MATCH query FTS5 itself rejects, e.g. bad syntax) so a search never hard-fails. */
export function searchDocsBlocks(query: string, opts: { sessionId?: string; limit?: number } = {}): DocsSearchResult[] {
  const limit = opts.limit ?? 20;
  if (ftsAvailable) {
    try {
      const sql = opts.sessionId
        ? `SELECT block_id, session_id, source, title, created_at, snippet(docs_fts, 0, '[', ']', '…', 12) as snip FROM docs_fts WHERE docs_fts MATCH ? AND session_id = ? ORDER BY rank LIMIT ?`
        : `SELECT block_id, session_id, source, title, created_at, snippet(docs_fts, 0, '[', ']', '…', 12) as snip FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`;
      const rows = (
        opts.sessionId ? db.query(sql).all(query, opts.sessionId, limit) : db.query(sql).all(query, limit)
      ) as Array<{
        block_id: number;
        session_id: string;
        source: string;
        title: string | null;
        created_at: number;
        snip: string;
      }>;
      return rows.map((r) => ({
        id: r.block_id,
        sessionId: r.session_id,
        source: r.source,
        title: r.title,
        snippet: r.snip,
        createdAt: r.created_at,
      }));
    } catch (e) {
      console.error("[dataStore] FTS5 search query failed, falling back to LIKE scan:", errorMessage(e));
    }
  }
  const like = `%${query}%`;
  const sql = opts.sessionId
    ? `SELECT id, session_id, source, title, content, created_at FROM docs_blocks WHERE session_id = ? AND (content LIKE ? OR title LIKE ? OR source LIKE ?) ORDER BY id DESC LIMIT ?`
    : `SELECT id, session_id, source, title, content, created_at FROM docs_blocks WHERE content LIKE ? OR title LIKE ? OR source LIKE ? ORDER BY id DESC LIMIT ?`;
  const rows = (
    opts.sessionId
      ? db.query(sql).all(opts.sessionId, like, like, like, limit)
      : db.query(sql).all(like, like, like, limit)
  ) as Array<DocsBlockRow & { content: string }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    source: r.source,
    title: r.title,
    snippet: likeSnippet(r.content, query),
    createdAt: r.created_at,
  }));
}

export function listSessions(opts: { limit?: number } = {}): SessionSummary[] {
  const limit = opts.limit ?? 50;
  const rows = db
    .query(
      `
      SELECT s.id, s.name, s.started_at, s.ended_at, s.tool_calls,
        (SELECT COUNT(*) FROM artifacts a WHERE a.session_id = s.id AND a.kind = 'image') as images,
        (SELECT COUNT(*) FROM artifacts a WHERE a.session_id = s.id AND a.kind = 'video') as videos,
        (SELECT COUNT(*) FROM docs_blocks d WHERE d.session_id = s.id) as docsBlocks,
        (SELECT COALESCE(SUM(char_count), 0) FROM docs_blocks d WHERE d.session_id = s.id) as docsChars
      FROM sessions s ORDER BY s.started_at DESC LIMIT ?
      `,
    )
    .all(limit) as Array<{
    id: string;
    name: string | null;
    started_at: number;
    ended_at: number | null;
    tool_calls: number;
    images: number;
    videos: number;
    docsBlocks: number;
    docsChars: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    toolCalls: r.tool_calls,
    images: r.images,
    videos: r.videos,
    docsBlocks: r.docsBlocks,
    docsChars: r.docsChars,
  }));
}

export function getSessionDetail(id: string): SessionDetail | undefined {
  const s = db.query(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | {
        id: string;
        name: string | null;
        started_at: number;
        ended_at: number | null;
        tool_calls: number;
        hosts_json: string;
      }
    | undefined;
  if (!s) return undefined;
  const artifacts = db
    .query(`SELECT id, kind, path, source, size_bytes, created_at FROM artifacts WHERE session_id = ? ORDER BY id`)
    .all(id) as Array<{
    id: number;
    kind: string;
    path: string;
    source: string | null;
    size_bytes: number | null;
    created_at: number;
  }>;
  const docBlockList = listDocsBlocks({ sessionId: id, limit: 1000 });
  let hosts: string[] = [];
  try {
    hosts = JSON.parse(s.hosts_json);
  } catch {}
  return {
    id: s.id,
    name: s.name,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    toolCalls: s.tool_calls,
    images: artifacts.filter((a) => a.kind === "image").length,
    videos: artifacts.filter((a) => a.kind === "video").length,
    docsBlocks: docBlockList.length,
    docsChars: docBlockList.reduce((n, b) => n + b.charCount, 0),
    hosts,
    artifacts: artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      path: a.path,
      source: a.source,
      sizeBytes: a.size_bytes,
      createdAt: a.created_at,
    })),
    docBlockList,
  };
}

/**
 * Deletes artifact files from disk (best-effort per file — a file that's
 * already gone or locked is logged as an error, not fatal to the rest) and
 * every DB row for each session id. ONLY ever called from dataCli.ts's `gc`
 * command with filters a human explicitly passed — never from the daemon
 * itself, and never with an implicit "everything" default.
 */
export function deleteSessions(ids: string[]): DeleteSummary {
  const summary: DeleteSummary = {
    deletedSessions: 0,
    deletedFiles: 0,
    freedBytes: 0,
    errors: [],
  };
  for (const id of ids) {
    const artifacts = db.query(`SELECT path, size_bytes FROM artifacts WHERE session_id = ?`).all(id) as Array<{
      path: string;
      size_bytes: number | null;
    }>;
    for (const a of artifacts) {
      let size = a.size_bytes;
      if (size == null) {
        try {
          size = statSync(a.path).size;
        } catch {
          size = 0;
        }
      }
      try {
        unlinkSync(a.path);
        summary.deletedFiles++;
        summary.freedBytes += size ?? 0;
      } catch (e) {
        summary.errors.push(`${a.path}: ${errorMessage(e)}`);
      }
    }
    db.query(`DELETE FROM artifacts WHERE session_id = ?`).run(id);
    db.query(`DELETE FROM docs_blocks WHERE session_id = ?`).run(id);
    if (ftsAvailable) {
      try {
        db.query(`DELETE FROM docs_fts WHERE session_id = ?`).run(id);
      } catch {}
    }
    const res = db.query(`DELETE FROM sessions WHERE id = ?`).run(id);
    if (res.changes > 0) summary.deletedSessions++;
  }
  return summary;
}

export function dbFileSizeBytes(): number {
  try {
    return statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

// --- Saved flows (browser_knowledge's save_flow / list_flows / side panel) ---

function metaFromFlowRow(row: FlowRow): FlowMeta {
  let stepCount = 0;
  try {
    stepCount = (JSON.parse(row.steps_json) as unknown[]).length;
  } catch {}
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    domain: row.domain,
    stepCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Creates a new flow (omit `id`) or overwrites an existing one (pass its id) — same upsert shape as browser_knowledge's save_skill. */
export function saveFlow(input: {
  id?: string;
  name: string;
  description?: string;
  domain?: string;
  steps: FlowStep[];
}): FlowMeta {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const stepsJson = JSON.stringify(input.steps);
  const existing = db.query(`SELECT created_at FROM flows WHERE id = ?`).get(id) as { created_at: number } | undefined;
  const createdAt = existing?.created_at ?? now;
  db.query(
    `INSERT INTO flows (id, name, description, domain, steps_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, description = excluded.description,
      domain = excluded.domain, steps_json = excluded.steps_json,
      updated_at = excluded.updated_at`,
  ).run(id, input.name, input.description ?? null, input.domain ?? null, stepsJson, createdAt, now);
  return {
    id,
    name: input.name,
    description: input.description ?? null,
    domain: input.domain ?? null,
    stepCount: input.steps.length,
    createdAt,
    updatedAt: now,
  };
}

/** Metadata only (no steps) — same "cheap list" shape as listDocsBlocks/browser_knowledge's list_skills. */
export function listFlows(opts: { domain?: string } = {}): FlowMeta[] {
  const rows = (
    opts.domain
      ? db.query(`SELECT * FROM flows WHERE domain = ? ORDER BY updated_at DESC`).all(opts.domain)
      : db.query(`SELECT * FROM flows ORDER BY updated_at DESC`).all()
  ) as FlowRow[];
  return rows.map(metaFromFlowRow);
}

export function getFlow(id: string): FlowFull | undefined {
  const row = db.query(`SELECT * FROM flows WHERE id = ?`).get(id) as FlowRow | undefined;
  if (!row) return undefined;
  let steps: FlowStep[] = [];
  try {
    steps = JSON.parse(row.steps_json);
  } catch {}
  return { ...metaFromFlowRow(row), steps };
}

export function deleteFlow(id: string): boolean {
  const res = db.query(`DELETE FROM flows WHERE id = ?`).run(id);
  return res.changes > 0;
}

// --- Benchmark & Token Analytics ---

export function recordToolCallDetail(input: ToolCallRecordInput): void {
  try {
    const inChars = input.inChars ?? JSON.stringify(input.args ?? {}).length + input.cmd.length;
    const inTokens = input.inTokens ?? Math.max(1, Math.round(inChars / 4));
    const outChars = input.outChars ?? (input.approxChars > inChars ? input.approxChars - inChars : input.approxChars);
    const outTokens = input.outTokens ?? Math.max(1, Math.round(outChars / 4));
    const totalTokens = inTokens + outTokens;

    db.query(
      `INSERT INTO tool_calls (
        session_id, cmd, args_json, duration_ms, in_chars, in_tokens,
        out_chars, out_tokens, approx_chars, approx_tokens, has_image,
        is_error, source, preview, element_role, element_name,
        step_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.cmd,
      JSON.stringify(input.args ?? {}),
      input.durationMs,
      inChars,
      inTokens,
      outChars,
      outTokens,
      inChars + outChars,
      totalTokens,
      input.hasImage ? 1 : 0,
      input.isError ? 1 : 0,
      input.source,
      input.preview,
      input.elementRole ?? null,
      input.elementName ?? null,
      input.stepCount ?? 0,
      input.createdAt ?? Date.now(),
    );
  } catch (e) {
    console.error("[dataStore] Failed to record tool call detail:", e);
  }
}

export function getBenchmarkMetrics(sessionId?: string): BenchmarkMetrics {
  const sessionRow = sessionId
    ? (db.query(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
        | {
            id: string;
            name: string;
            started_at: number;
          }
        | undefined)
    : (db.query(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
        | { id: string; name: string; started_at: number }
        | undefined);

  const activeSessionId = sessionId ?? sessionRow?.id ?? "current";
  const sessionName = sessionRow?.name || "Active Session";
  const startedAt = sessionRow?.started_at || Date.now();

  interface CallRow {
    id: number;
    cmd: string;
    args_json: string;
    duration_ms: number;
    in_chars?: number;
    in_tokens?: number;
    out_chars?: number;
    out_tokens?: number;
    approx_chars: number;
    approx_tokens: number;
    is_error: number;
    source: string;
    preview: string;
    element_role: string | null;
    element_name: string | null;
    step_count: number;
    created_at: number;
  }

  const rows = db
    .query(`SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(activeSessionId) as CallRow[];

  interface AggRow {
    cmd: string;
    count: number;
    total_in_tokens: number;
    total_out_tokens: number;
    total_tokens: number;
    total_duration: number;
    error_count: number;
    step_total: number;
  }

  const aggRows = db
    .query(
      `SELECT cmd, COUNT(*) as count,
          SUM(COALESCE(in_tokens, 0)) as total_in_tokens,
          SUM(COALESCE(out_tokens, approx_tokens)) as total_out_tokens,
          SUM(approx_tokens) as total_tokens,
          SUM(duration_ms) as total_duration,
          SUM(is_error) as error_count,
          SUM(step_count) as step_total
      FROM tool_calls
      WHERE session_id = ?
      GROUP BY cmd
      ORDER BY total_tokens DESC`,
    )
    .all(activeSessionId) as AggRow[];

  let totalCalls = 0;
  let totalInTokens = 0;
  let totalOutTokens = 0;
  let totalTokens = 0;
  let totalInChars = 0;
  let totalOutChars = 0;
  let totalDurationMs = 0;
  let errorCount = 0;
  let flowStepTotal = 0;

  for (const r of rows) {
    totalCalls++;
    const inTok =
      r.in_tokens && r.in_tokens > 0 ? r.in_tokens : Math.max(1, Math.round((r.args_json.length + r.cmd.length) / 4));
    const outTok =
      r.out_tokens && r.out_tokens > 0
        ? r.out_tokens
        : Math.max(1, r.approx_tokens > inTok ? r.approx_tokens - inTok : r.approx_tokens);
    const inChar = r.in_chars && r.in_chars > 0 ? r.in_chars : r.args_json.length + r.cmd.length;
    const outChar =
      r.out_chars && r.out_chars > 0 ? r.out_chars : r.approx_chars > inChar ? r.approx_chars - inChar : r.approx_chars;

    totalInTokens += inTok;
    totalOutTokens += outTok;
    totalTokens += inTok + outTok;
    totalInChars += inChar;
    totalOutChars += outChar;
    totalDurationMs += r.duration_ms || 0;
    if (r.is_error === 1) errorCount++;
    flowStepTotal += r.step_count || 0;
  }

  const byCommand = aggRows.map((a) => {
    const inTok =
      a.total_in_tokens && a.total_in_tokens > 0 ? a.total_in_tokens : Math.max(1, Math.round(a.count * 15));
    const outTok =
      a.total_out_tokens && a.total_out_tokens > 0 ? a.total_out_tokens : Math.max(1, a.total_tokens - inTok);
    const total = inTok + outTok;
    return {
      cmd: a.cmd,
      count: a.count,
      inTokens: inTok,
      outTokens: outTok,
      totalTokens: total,
      avgTokens: a.count > 0 ? Math.round(total / a.count) : 0,
      totalDurationMs: a.total_duration || 0,
      avgDurationMs: a.count > 0 ? Math.round((a.total_duration || 0) / a.count) : 0,
      errorCount: a.error_count || 0,
      pctOfTokens: totalTokens > 0 ? Math.round((total / totalTokens) * 100) : 0,
    };
  });

  /**
   * Estimate accurate token savings for this specific session:
   * 1. Flow Batching: each batched step avoids 1 extra tool round-trip (~350 tokens of prompt+reasoning overhead)
   */
  const runFlowCount = aggRows.find((a) => a.cmd === "run_flow" || a.cmd === "explore_flow")?.count ?? 0;
  const fromFlowBatching = Math.max(0, (flowStepTotal - runFlowCount) * 350);

  // 2. Compact snapshot savings: ~75% whitespace/JSON overhead avoided
  const compactSnapshots = rows.filter((r) => r.cmd === "snapshot" && r.args_json.includes('"compact":true'));
  const fromCompactSnapshots = compactSnapshots.reduce((acc, r) => acc + Math.round(r.approx_tokens * 2.5), 0);

  // 3. Docs blocks instead of full text reading dump into LLM context:
  const docsRow = db
    .query(`SELECT SUM(char_count) as total_chars FROM docs_blocks WHERE session_id = ?`)
    .get(activeSessionId) as { total_chars: number | null } | undefined;
  const fromDocsBlocks = Math.round((docsRow?.total_chars ?? 0) / 4);

  const estimatedSavedTokens = fromFlowBatching + fromCompactSnapshots + fromDocsBlocks;

  const recentCalls = rows.map((r) => {
    let argsSummary = "";
    try {
      const parsed = JSON.parse(r.args_json);
      if (parsed.url) argsSummary = parsed.url;
      else if (parsed.nodeId) argsSummary = `nodeId: ${parsed.nodeId}`;
      else if (parsed.query) argsSummary = `"${parsed.query}"`;
      else if (parsed.selector) argsSummary = `"${parsed.selector}"`;
      else if (parsed.action) argsSummary = parsed.action;
    } catch {}

    const inTok =
      r.in_tokens && r.in_tokens > 0 ? r.in_tokens : Math.max(1, Math.round((r.args_json.length + r.cmd.length) / 4));
    const outTok =
      r.out_tokens && r.out_tokens > 0
        ? r.out_tokens
        : Math.max(1, r.approx_tokens > inTok ? r.approx_tokens - inTok : r.approx_tokens);

    return {
      id: r.id,
      cmd: r.cmd,
      durationMs: r.duration_ms,
      inTokens: inTok,
      outTokens: outTok,
      approxTokens: inTok + outTok,
      isError: r.is_error === 1,
      source: r.source,
      preview: r.preview,
      elementRole: r.element_role ?? undefined,
      elementName: r.element_name ?? undefined,
      stepCount: r.step_count || undefined,
      createdAt: r.created_at,
      argsSummary,
    };
  });

  return {
    summary: {
      sessionId: activeSessionId,
      sessionName,
      startedAt,
      totalCalls,
      totalInTokens,
      totalOutTokens,
      totalTokens,
      totalInChars,
      totalOutChars,
      avgInTokensPerCall: totalCalls > 0 ? Math.round(totalInTokens / totalCalls) : 0,
      avgOutTokensPerCall: totalCalls > 0 ? Math.round(totalOutTokens / totalCalls) : 0,
      avgTokensPerCall: totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0,
      avgDurationMs: totalCalls > 0 ? Math.round(totalDurationMs / totalCalls) : 0,
      totalDurationMs,
      errorCount,
      errorRatePct: totalCalls > 0 ? Math.round((errorCount / totalCalls) * 100) : 0,
      flowStepTotal,
    },
    tokenSavings: {
      estimatedSavedTokens,
      savingsBreakdown: {
        fromFlowBatching,
        fromCompactSnapshots,
        fromDocsBlocks,
      },
    },
    byCommand,
    recentCalls,
  };
}

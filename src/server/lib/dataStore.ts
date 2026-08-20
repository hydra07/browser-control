// SQLite index over data/ — the missing "which session made this, is it
// safe to delete, can I search it" layer. Deliberately NOT a replacement
// for the on-disk log/image/video files (replay.ts still reads JSONL
// directly, screenshots/recordings stay real files) — this only indexes
// them, plus becomes the new home for crawled/extracted content that used
// to live in one ever-growing data/docs/docs-<ts>.md per session (see
// addDocsBlock below).
//
// No auto-deletion lives here or anywhere in the daemon — deleteSessions()
// exists for dataCli.ts's `gc` command, which requires an explicit filter
// from a human before it's ever called. The daemon itself only ever reads
// and appends.
import { Database } from "bun:sqlite";
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
try {
    mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const db = new Database(join(DATA_DIR, "index.sqlite"));
db.exec("PRAGMA journal_mode = WAL");

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

// A standalone (not external-content) FTS5 table — duplicates the text
// rather than linking back to docs_blocks by rowid, which costs roughly 2x
// storage for docs content but means delete-by-session is one plain DELETE
// instead of external-content-table bookkeeping. Given the "keep
// everything" retention policy, the simpler table is worth the extra disk.
// Guarded: some Bun/SQLite builds may lack FTS5, so search falls back to a
// LIKE scan over docs_blocks if this table never gets created.
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
    console.error(
        "[dataStore] FTS5 unavailable, docs search will fall back to a plain LIKE scan:",
        e instanceof Error ? e.message : String(e),
    );
}

const HOSTS_STORE_CAP = 50;
const HOSTS_NAME_SHOW_CAP = 5;

function formatAutoName(hosts: string[]): string {
    if (hosts.length === 0) return "";
    const shown = hosts.slice(0, HOSTS_NAME_SHOW_CAP);
    const rest = hosts.length - shown.length;
    return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

export function initSession(id: string, opts: { pid?: number } = {}): void {
    db.query(
        `INSERT OR IGNORE INTO sessions (id, started_at, pid) VALUES (?, ?, ?)`,
    ).run(id, Date.now(), opts.pid ?? null);
}

/** Best-effort — called on SIGINT/SIGTERM so `sessions.ended_at` reflects a clean shutdown rather than staying NULL forever. */
export function endSession(id: string): void {
    try {
        db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(
            Date.now(),
            id,
        );
    } catch {}
}

export function recordToolCall(sessionId: string): void {
    try {
        db.query(
            `UPDATE sessions SET tool_calls = tool_calls + 1 WHERE id = ?`,
        ).run(sessionId);
    } catch {}
}

/** Dedups into hosts_json (capped) and, unless the session has a custom name, recomputes `name` from the visited-hostname list — the zero-effort default a session gets without anyone calling browser_set_session_name. */
export function recordHostVisit(sessionId: string, hostname: string): void {
    if (!hostname) return;
    try {
        const row = db
            .query(
                `SELECT hosts_json, name_is_custom FROM sessions WHERE id = ?`,
            )
            .get(sessionId) as
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
            db.query(`UPDATE sessions SET hosts_json = ? WHERE id = ?`).run(
                JSON.stringify(hosts),
                sessionId,
            );
        } else {
            db.query(
                `UPDATE sessions SET hosts_json = ?, name = ? WHERE id = ?`,
            ).run(JSON.stringify(hosts), formatAutoName(hosts), sessionId);
        }
    } catch {}
}

/** Explicit override — sets name_is_custom so recordHostVisit stops touching `name`. Used by browser_set_session_name and dataCli.ts's `rename`. */
export function setSessionName(sessionId: string, name: string): void {
    db.query(
        `UPDATE sessions SET name = ?, name_is_custom = 1 WHERE id = ?`,
    ).run(name, sessionId);
}

export interface RecordArtifactInput {
    sessionId: string;
    kind: "log" | "image" | "video";
    path: string;
    source?: string;
    // Omit for 'log' — that file is appended to for the whole session, so a
    // cached size would go stale immediately; callers stat it live instead
    // (see dataCli.ts). image/video are write-once, so the caller passes
    // the real size at insert time.
    sizeBytes?: number;
    createdAt?: number;
}

export function recordArtifact(input: RecordArtifactInput): number {
    const result = db
        .query(
            `INSERT INTO artifacts (session_id, kind, path, source, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
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

export interface DocsBlockMeta {
    id: number;
    sessionId: string;
    source: string;
    title: string | null;
    charCount: number;
    createdAt: number;
}

interface DocsBlockRow {
    id: number;
    session_id: string;
    source: string;
    title: string | null;
    char_count: number;
    created_at: number;
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

export interface DocsBlockResult {
    blockId: number;
    charCount: number;
    sessionTotalChars: number;
}

/**
 * The replacement for the old docs.ts's appendContentToDocsFile — one row
 * per call instead of one more chunk glued onto a single ever-growing
 * per-session markdown file. `source` is a short label (a URL, a selector,
 * "job task: <url>") describing where this content came from; browse it via
 * listDocsBlocks/searchDocsBlocks/getDocsBlock (browser_query_docs), not by
 * reading a file path.
 */
export function addDocsBlock(
    sessionId: string,
    content: string,
    source: string,
    title?: string,
): DocsBlockResult {
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
            console.error(
                "[dataStore] docs_fts insert failed (search index may be incomplete):",
                e instanceof Error ? e.message : String(e),
            );
        }
    }
    const totalRow = db
        .query(
            `SELECT COALESCE(SUM(char_count), 0) as total FROM docs_blocks WHERE session_id = ?`,
        )
        .get(sessionId) as { total: number };
    return { blockId, charCount, sessionTotalChars: totalRow.total };
}

/** Metadata only (id, source, title, charCount, createdAt) — same "cheap list, fetch detail separately" shape as browser_list_skills/browser_snapshot. */
export function listDocsBlocks(
    opts: { sessionId?: string; limit?: number } = {},
): DocsBlockMeta[] {
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

export interface DocsBlockFull extends DocsBlockMeta {
    content: string;
}

export function getDocsBlock(id: number): DocsBlockFull | undefined {
    const row = db
        .query(
            `SELECT id, session_id, source, title, content, char_count, created_at FROM docs_blocks WHERE id = ?`,
        )
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

export interface DocsSearchResult {
    id: number;
    sessionId: string;
    source: string;
    title: string | null;
    snippet: string;
    createdAt: number;
}

/** FTS5 MATCH + snippet() when available; falls back to a plain LIKE scan over docs_blocks (both on ftsAvailable:false and on a MATCH query FTS5 itself rejects, e.g. bad syntax) so a search never hard-fails. */
export function searchDocsBlocks(
    query: string,
    opts: { sessionId?: string; limit?: number } = {},
): DocsSearchResult[] {
    const limit = opts.limit ?? 20;
    if (ftsAvailable) {
        try {
            const sql = opts.sessionId
                ? `SELECT block_id, session_id, source, title, created_at, snippet(docs_fts, 0, '[', ']', '…', 12) as snip FROM docs_fts WHERE docs_fts MATCH ? AND session_id = ? ORDER BY rank LIMIT ?`
                : `SELECT block_id, session_id, source, title, created_at, snippet(docs_fts, 0, '[', ']', '…', 12) as snip FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`;
            const rows = (
                opts.sessionId
                    ? db.query(sql).all(query, opts.sessionId, limit)
                    : db.query(sql).all(query, limit)
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
            console.error(
                "[dataStore] FTS5 search query failed, falling back to LIKE scan:",
                e instanceof Error ? e.message : String(e),
            );
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

export interface SessionSummary {
    id: string;
    name: string | null;
    startedAt: number;
    endedAt: number | null;
    toolCalls: number;
    images: number;
    videos: number;
    docsBlocks: number;
    docsChars: number;
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

export interface ArtifactRow {
    id: number;
    kind: string;
    path: string;
    source: string | null;
    sizeBytes: number | null;
    createdAt: number;
}

export interface SessionDetail extends SessionSummary {
    hosts: string[];
    artifacts: ArtifactRow[];
    docBlockList: DocsBlockMeta[];
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
        .query(
            `SELECT id, kind, path, source, size_bytes, created_at FROM artifacts WHERE session_id = ? ORDER BY id`,
        )
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

export interface DeleteSummary {
    deletedSessions: number;
    deletedFiles: number;
    freedBytes: number;
    errors: string[];
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
        const artifacts = db
            .query(`SELECT path, size_bytes FROM artifacts WHERE session_id = ?`)
            .all(id) as Array<{ path: string; size_bytes: number | null }>;
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
                summary.errors.push(
                    `${a.path}: ${e instanceof Error ? e.message : String(e)}`,
                );
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
        return statSync(join(DATA_DIR, "index.sqlite")).size;
    } catch {
        return 0;
    }
}

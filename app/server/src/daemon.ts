import { serve } from "bun";
import type { ServerWebSocket } from "bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordAndCheckFlow } from "./lib/sessionFlow.js";
import * as dataStore from "./lib/dataStore.js";
import { startJob, getJobStatusText, jobExists, MAX_JOB_TASKS, MAX_CONCURRENT_JOBS } from "./lib/jobs.js";
import type { JobTaskInput } from "./lib/jobs.js";
import { startDeepCrawl, getDeepCrawlStatusText, crawlExists, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, MAX_CONCURRENT_CRAWLS } from "./lib/crawl.js";
import type { ExtensionResponse, FlowStep } from "@browsercontrol/shared";
import pkg from "../package.json" with { type: "json" };

// One id for the whole daemon process, used everywhere a "session" needs
// naming: the log filename, the dataStore sessions row, and every docs
// block written by this process. Previously the log file and the old
// docs.ts's per-session markdown file each computed their OWN Date.now(),
// which only ever matched by the luck of both modules loading in the same
// millisecond at startup — not a real shared identifier.
const SESSION_ID = String(Date.now());

// This server's own version — @browsercontrol/server's package.json, not
// the Chrome extension's manifest.json. The two are separate codebases now
// (app/server vs. app/extension) and are allowed to version independently;
// this used to reach across into the extension's manifest.json specifically
// to keep one shared number, which is exactly the cross-app coupling this
// split is meant to remove.
const PACKAGE_VERSION: string = pkg.version ?? "0.0.0";

// The daemon never validates a tool's `arguments` against a schema beyond
// what the MCP SDK already does — logging/forwarding code just needs "some
// JSON-serializable object", not the exact shape, so `unknown` (not a typed
// union) is the honest type here.
type ToolArgs = Record<string, unknown> | undefined;
// executeCommand's return is whatever background.ts's dispatchCommand
// returned for that cmd (see the BrowserCommand-keyed branches in
// background.ts) — a different shape per command, so callers narrow with
// optional chaining rather than this being `any`.
type CommandResult = Record<string, unknown>;
type ToolCallResponse = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

// Redirect all console output to stderr to prevent corrupting MCP JSON-RPC over stdout
console.log = console.error;
console.info = console.error;

// Not all MCP clients render inline image content blocks — some Antigravity
// CLI versions can't handle images from MCP servers at all, and when they
// can't, the base64 payload risks being dumped into the model's context as
// raw text instead of being discarded (a single ~700KB PNG is ~230k tokens
// that way). Default to file-only; set BROWSERCONTROL_INLINE_IMAGES=true for
// clients (e.g. Claude Code) known to handle image content blocks properly.
const INLINE_IMAGES = process.env.BROWSERCONTROL_INLINE_IMAGES === "true";

// data/images and data/videos replace the old top-level screenshots/ dir —
// one place for everything browser_screenshot/browser_snapshot({visual:true})/
// browser_start_recording+browser_stop_recording write to disk.
const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const VIDEOS_DIR = join(DATA_DIR, "videos");
try { mkdirSync(IMAGES_DIR, { recursive: true }); } catch {}
try { mkdirSync(VIDEOS_DIR, { recursive: true }); } catch {}

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

// Every tool call gets logged here — this is what actually answers "which
// call burned the tokens", instead of guessing from a pasted transcript
// after the fact. One JSONL file per daemon process (= roughly one MCP
// client session), so a session's calls are easy to isolate and grep.
// Lives under data/ now (used to be a separate top-level logs/ dir) so
// everything a session produces — log, docs index, images, videos — sits
// under one root dataCli.ts/dataStore.ts can reason about.
const LOGS_DIR = join(DATA_DIR, "logs");
try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

// One-time best-effort migration: an older checkout may still have a
// top-level logs/ dir from before this moved under data/. Move whatever's
// there over so a single `mise run data:*` command sees the full history
// instead of half of it being invisible in the old location. Never fatal —
// worst case the old files just stay where they are.
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

const PREVIEW_CHARS = 300;

// --- Per-domain skills ---
// A skill is a durable, discoverable record of what the AI already knows
// about a site (working selectors, role/name pairs, flow sequences) — the
// point is to pay the exploration cost once (see browser_run_flow's
// explore:true mode) and
// reuse it across every future session, instead of re-discovering the same
// page from scratch every time (which is what happened before this existed:
// an agent hand-wrote its own walkthrough.md/test-flow.json, which worked
// but wasn't discoverable by a different session or a different agent).
// Format deliberately mirrors Claude Code's own SKILL.md convention so it
// reads the same way to both the user and the AI.
const SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "skills");
try { mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const MAX_SKILL_CONTENT_CHARS = 50_000;

interface SkillMeta {
  name: string;
  domains: string[];
  description?: string;
  path: string;
}

// The format is entirely self-produced (only browser_save_skill ever writes
// it), so a small regex parser matching exactly that shape is enough —
// no need for a real YAML dependency for a frontmatter block this narrow.
function parseSkillFrontmatter(content: string): { name?: string; domains: string[]; description?: string } {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const domainsBlock = fm.match(/^domains:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1] ?? "";
  const domains = domainsBlock
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: fm.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
    domains,
  };
}

function listSkills(filter?: { domain?: string; query?: string }): SkillMeta[] {
  let dirs: string[];
  try {
    dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const dir of dirs) {
    const path = join(SKILLS_DIR, dir, "SKILL.md");
    try {
      const content = readFileSync(path, "utf8");
      const meta = parseSkillFrontmatter(content);
      skills.push({ name: meta.name ?? dir, domains: meta.domains, description: meta.description, path });
    } catch {
      // A manually-broken skill dir (missing/unreadable SKILL.md) shouldn't
      // crash listing every other valid skill.
    }
  }
  // Metadata-only (name/domains/description, never the full SKILL.md body)
  // keeps even an unfiltered call cheap, but as the skill count grows a
  // caller that already knows what it's after shouldn't have to read past
  // every other skill's metadata to find it — same "query instead of dump"
  // shape as browser_find vs. browser_snapshot.
  if (filter?.domain) {
    const domain = filter.domain.toLowerCase();
    return skills.filter((s) => s.domains.some((d) => d.toLowerCase() === domain));
  }
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.domains.some((d) => d.toLowerCase().includes(q)),
    );
  }
  return skills;
}

function findSkillForHostname(hostname: string): SkillMeta | undefined {
  return listSkills().find((s) => s.domains.includes(hostname));
}

// Surfaced as a non-fatal `_duplicateWarning` on browser_save_skill's
// response when creating a genuinely NEW skill (not updating an existing
// one) whose domains overlap another skill's — the tool description already
// asks the caller to check browser_list_skills first, but that's easy to
// skip; this catches the actual consequence (near-duplicate skills for the
// same site) at the point it would happen instead of relying on the caller
// having read the docs.
function findOverlappingSkill(
  name: string,
  domains: string[],
): SkillMeta | undefined {
  return listSkills().find(
    (s) => s.name !== name && s.domains.some((d) => domains.includes(d)),
  );
}

function buildSkillFile(name: string, domains: string[], description: string | undefined, content: string): string {
  const domainsYaml = domains.map((d) => `  - ${d}`).join("\n");
  const frontmatter = [
    "---",
    `name: ${name}`,
    "domains:",
    domainsYaml,
    ...(description ? [`description: ${description}`] : []),
    "---",
    "",
  ].join("\n");
  return frontmatter + content;
}

function saveSkill(args: { name?: unknown; domains?: unknown; description?: unknown; content?: unknown }): Record<string, unknown> {
  const name = typeof args.name === "string" ? args.name : "";
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { error: `Invalid skill name: "${name}"`, hint: "Use a lowercase slug (letters, numbers, hyphens, underscores only), e.g. \"github\" or \"mio-fe-admin-inquiries\"." };
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return { error: `Skill content too long (${content.length} chars, max ${MAX_SKILL_CONTENT_CHARS})`, hint: "Trim to the essentials — selectors, role/name pairs, flow sequences, gotchas. This isn't meant to hold full page dumps." };
  }

  const path = join(SKILLS_DIR, name, "SKILL.md");
  let domains: string[] | undefined = Array.isArray(args.domains) ? args.domains.filter((d): d is string => typeof d === "string") : undefined;
  let description = typeof args.description === "string" ? args.description : undefined;

  // Preserve existing domains/description on an update rather than
  // erroring or silently dropping them — only require domains up front
  // when there's no prior file to inherit them from. A partial update
  // (content only) shouldn't wipe metadata the caller didn't mean to touch.
  if ((!domains || domains.length === 0) || description === undefined) {
    const existing = existsSync(path) ? parseSkillFrontmatter(readFileSync(path, "utf8")) : undefined;
    if (!domains || domains.length === 0) {
      if (existing) {
        domains = existing.domains;
      } else {
        return { error: "Missing domains", hint: "New skills need at least one domain (e.g. [\"github.com\"]) so browser_navigate can find them. Omit only when updating a skill that already has domains set." };
      }
    }
    if (description === undefined) description = existing?.description;
  }

  const isNewSkill = !existsSync(path);
  const overlap = isNewSkill ? findOverlappingSkill(name, domains) : undefined;

  try {
    mkdirSync(join(SKILLS_DIR, name), { recursive: true });
    writeFileSync(path, buildSkillFile(name, domains, description, content));
  } catch (e) {
    return { error: `Failed to write skill: ${e instanceof Error ? e.message : String(e)}` };
  }
  return {
    success: true,
    message: `Saved skill "${name}"`,
    path,
    domains,
    ...(overlap
      ? {
          _duplicateWarning: `Skill "${overlap.name}" (${overlap.path}) already covers ${overlap.domains.filter((d) => domains!.includes(d)).join(", ")}. Consider merging into that one (browser_save_skill with name:"${overlap.name}") instead of keeping both — two skills for the same site drift out of sync and cost double the context on every browser_list_skills call.`,
        }
      : {}),
  };
}

function writeCallLog(entry: { ts: string; cmd: string; args: ToolArgs; durationMs: number; approxChars: number; approxTokens: number; hasImage: boolean; isError: boolean; source: string; preview: string; elementRole?: string; elementName?: string }): void {
  try { appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch {}
  console.error(`[tool:${entry.source}] ${entry.cmd} ${entry.durationMs}ms ~${entry.approxTokens}tok${entry.hasImage ? ' [image]' : ''}${entry.isError ? ' ERROR' : ''}`);
}

function logToolCall(name: string, args: ToolArgs, response: ToolCallResponse, durationMs: number): void {
  let approxChars = 0;
  let hasImage = false;
  let text = "";
  for (const item of response?.content ?? []) {
    if (item.type === "text") { approxChars += item.text?.length ?? 0; text += item.text ?? ""; }
    if (item.type === "image") { approxChars += item.data?.length ?? 0; hasImage = true; }
  }
  // click/type responses carry {role, name} (see background.ts's
  // getAxInfoForNode) so replay can re-resolve "the button named X" against
  // a fresh snapshot instead of trusting a backendDOMNodeId that's already
  // stale the moment the page reloads. Best-effort parse since `text` here
  // is whatever JSON.stringify produced for the raw command result.
  let elementRole: string | undefined, elementName: string | undefined;
  try {
    const parsed = JSON.parse(text) as { role?: string; name?: string };
    elementRole = parsed?.role;
    elementName = parsed?.name;
  } catch {}
  writeCallLog({
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

// /execute (used by replay.ts and any other direct HTTP caller) bypasses the
// MCP layer entirely, so without this it was invisible to logs/ — the first
// investigation of "why didn't replay show up in any log file" traced back
// to exactly this gap.
// Covers both shapes this actually receives: a real ExtensionResponse
// relayed from the extension, and an ad-hoc {error, hint} object built
// locally on timeout — hence the loose Record rather than ExtensionResponse
// itself.
function logDirectCall(cmd: string | undefined, args: ToolArgs, response: Record<string, unknown> | undefined, durationMs: number): void {
  const json = JSON.stringify(response ?? {});
  const data = response?.data as { role?: string; name?: string } | undefined;
  writeCallLog({
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

let extensionSocket: ServerWebSocket<unknown> | null = null;
const pendingRequests = new Map<string, (val: ExtensionResponse) => void>();

// --- WebSocket & HTTP Server ---
const httpServer = serve({
  port: 8765,
  // Restrict to loopback only. Bun defaults to binding all interfaces, which
  // would otherwise let any other machine on the LAN drive this browser.
  hostname: "127.0.0.1",
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
              logDirectCall(body?.cmd, body, timeoutBody, Date.now() - start);
              resolve(new Response(JSON.stringify(timeoutBody), { status: 504 }));
            }
          }, 15000);

          pendingRequests.set(reqId, (extResponse) => {
            clearTimeout(timeout);
            logDirectCall(body?.cmd, body, extResponse as unknown as Record<string, unknown>, Date.now() - start);
            resolve(new Response(JSON.stringify(extResponse), { headers: { "Content-Type": "application/json" } }));
          });

          extensionSocket!.send(JSON.stringify({ id: reqId, ...body }));
        });
      }).catch(() => new Response("Invalid Request", { status: 400 }));
    }

    // Talked to directly by the side panel (a browser page, not an MCP
    // client) via plain fetch() — same pattern as /execute above, just for
    // browsing/running saved flows instead of relaying a raw command.
    // host_permissions already covers this origin so CORS shouldn't be an
    // issue, but the header costs nothing and removes any doubt.
    const JSON_CORS_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

    if (req.method === "GET" && url.pathname === "/flows") {
      return new Response(JSON.stringify({ flows: dataStore.listFlows() }), { headers: JSON_CORS_HEADERS });
    }

    const getFlowMatch = req.method === "GET" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (getFlowMatch) {
      const flowId = decodeURIComponent(getFlowMatch[1]);
      const flow = dataStore.getFlow(flowId);
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      return new Response(JSON.stringify({ flow }), { headers: JSON_CORS_HEADERS });
    }

    // Polled by the side panel to show a connection badge — the daemon
    // itself being reachable only proves this HTTP server is up; the thing
    // that actually determines whether any tool call (an MCP client's or
    // the panel's own Run button) will work is whether the extension's
    // background worker has a live WebSocket here (see the `open`/`close`
    // websocket handlers below that set/clear extensionSocket).
    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(
        JSON.stringify({ extensionConnected: extensionSocket != null, version: PACKAGE_VERSION }),
        { headers: JSON_CORS_HEADERS },
      );
    }

    const runMatch = req.method === "POST" ? url.pathname.match(/^\/flows\/([^/]+)\/run$/) : null;
    if (runMatch) {
      const flowId = decodeURIComponent(runMatch[1]);
      const flow = dataStore.getFlow(flowId);
      if (!flow) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      if (!extensionSocket) {
        return new Response(JSON.stringify({ error: "Extension not connected", hint: "Open chrome://extensions, make sure BrowserControl Agent is enabled, and reload it." }), { status: 503, headers: JSON_CORS_HEADERS });
      }
      return executeCommand("run_flow", { steps: flow.steps, domain: flow.domain ?? undefined })
        .then((report) => new Response(JSON.stringify(report), { headers: JSON_CORS_HEADERS }))
        .catch((e) => new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_CORS_HEADERS }));
    }

    const deleteMatch = req.method === "DELETE" ? url.pathname.match(/^\/flows\/([^/]+)$/) : null;
    if (deleteMatch) {
      const flowId = decodeURIComponent(deleteMatch[1]);
      const deleted = dataStore.deleteFlow(flowId);
      if (!deleted) {
        return new Response(JSON.stringify({ error: `No flow with id "${flowId}"` }), { status: 404, headers: JSON_CORS_HEADERS });
      }
      return new Response(JSON.stringify({ success: true }), { headers: JSON_CORS_HEADERS });
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

// --- Helper to execute via WebSocket ---
// timeoutMs default covers every normal command; stop_capture gets a longer
// one (see its call site) since it has to flush the MediaRecorder and
// base64-encode a multi-MB blob before it can respond, which the usual
// 15s budget (sized for CDP round trips) can undercut on a longer recording.
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

// --- MCP Server Setup ---
const mcpServer = new Server({
  name: "browsercontrol",
  version: PACKAGE_VERSION,
}, {
  capabilities: { tools: {} },
  instructions: `
BrowserControl drives real Chrome tabs (grouped as "🤖 AI Workspace") via
your everyday browser's debugger, not a headless/isolated instance. Every
tool defaults to whichever tab browser_navigate/browser_switch_tab last
pointed at — for a single-tab session, that's all you need, same as ever.
To work with more than one tab at once (compare two pages, fill a form on
one while watching another, anything genuinely parallel), pass tabId
(returned by browser_navigate, or from browser_list_tabs) on any tool call
to target that specific tab regardless of which one is "current" — no
switch_tab round trip needed between steps on different tabs. Open an
additional tab without disturbing the current one via
browser_navigate({url, newTab: true}); its response's tabId is what you
capture and reuse. Each tab keeps its own CDP session (attaching one
doesn't detach another), but note two things stay scoped to a single
tab regardless: browser_start_recording/browser_stop_recording, and the
network log (browser_network_requests/browser_network_clear).

When the work is "go read/extract N pages" rather than one interactive
flow, don't drive that yourself with N sequential browser_navigate calls.
For public, mostly-static content (docs, articles, wikis) at real volume,
use browser_batch_crawl (or browser_deep_crawl to also follow the links
each page turns up, to a depth you set) — these fetch directly, no tab
overhead, so they scale to dozens of pages. For pages needing an actual
login session or client-rendered content, use browser_start_job instead —
same idea, real tabs. browser_search gets you clean {title,url} results to
feed any of these instead of navigating to a search engine and parsing the
results page yourself. All three of the async ones (browser_start_job,
browser_deep_crawl) return an id almost immediately and keep working in
the background — poll browser_task_status(taskId) for progress; each poll
only returns what finished since your LAST check on that id, never
repeating a result, which is also why it's cheap to poll repeatedly
instead of trying to time it perfectly.

Whatever browser_select_content/browser_batch_crawl/browser_deep_crawl/
browser_start_job extract is saved as individual docs blocks (SQLite-backed,
NOT one growing file you read with offset/limit) — each returns the new
block id(s), and browser_query_docs is how you read one back
({action:"read", blockId}) or find the right one across everything saved
this session, or every session ever recorded with allSessions:true
({action:"search", query}). If you did something on a session worth being
able to find again later, browser_set_session_name({name}) labels it — not
required, sessions auto-name from the hostnames they visited, but a real
description is more useful than a hostname list.

"🤖 AI Workspace" is a two-way handoff, not just where the tabs you open
end up: the user can drag a tab they already have open into that group
themselves, and browser_list_tabs is how you find out — it's the only
notification channel, since there's no way for anything to interrupt you
mid-turn. Call it at the start of a session and whenever the user
references a tab they already have open ("check this", "I put a page
there"); entries with isNew:true are ones added since you last checked.
Use browser_switch_tab on the result to start working on it directly.

If a tool call returns "Unknown command: <name>" with a hint about a
version mismatch: this means the Chrome extension loaded in the browser is
an older build than this daemon (MV3 extensions never pick up source
changes automatically — reloading in chrome://extensions is required after
any browsercontrol update). Tell the user to reload the extension and retry.
Do NOT work around this by installing Playwright, Puppeteer, Selenium, or
writing your own screenshot script — you do not have a capability gap, you
have a stale extension, and installing other automation tooling will not
fix that and may not even be permitted in your environment.

Workflow for interacting with a page:
1. browser_navigate to the target URL. If the response includes a
   skillHint field, a skill already exists for this domain — read that file
   before doing any exploratory work; it may already have the selectors/
   flow you're about to spend calls rediscovering. No hint doesn't mean no
   skill could ever exist here — check browser_list_skills if you're not
   sure, or if the user mentions a skill by name.
2. browser_snapshot for a fast text list of interactive elements (id, role,
   name, value). If you're not fully confident which id is the right one
   (custom dropdowns, icon-only buttons, repeated labels), use
   browser_snapshot({visual:true}) instead — it draws a numbered box over
   every interactive element on a screenshot, so you can ground the id to a
   position before clicking.
3. browser_click / browser_type using the id from the snapshot. These
   dispatch real, trusted input events (same as a physical mouse/keyboard),
   so they exercise the actual event handlers a user would trigger.
4. browser_type only inserts text — it never submits anything on its own.
   To submit a search box or form, or navigate a custom dropdown, follow it
   with browser_press_key (Enter, Tab, Escape, arrows, ...).
5. After any action that changes the page (navigation, opening a modal,
   submitting a form), take a fresh snapshot before reusing an id — ids are
   backend DOM node ids and go stale once the page re-renders.
6. For a KNOWN multi-step flow (login, a multi-field form, a wizard), don't
   drive it one browser_click/browser_type call at a time — that costs one
   round trip (and one reasoning pass) per step. Instead, write the whole
   sequence as steps referencing elements by role+name (from the snapshot)
   and send it in one browser_run_flow call. Default to plain
   browser_run_flow, not explore:true — explore:true is for validating ONE
   uncertain sequence against an unfamiliar UI, not a general substitute for
   a plain run. Repeatedly running with explore:true instead of switching to
   plain once you already know the flow works is the single biggest token
   cost this tool has measured in practice — on a real multi-scenario test
   session, 10 explore:true calls alone accounted for over 75% of the
   session's total tool-call tokens, some individual calls running into the
   tens of thousands of tokens against a data-heavy page. If most of your
   browser_run_flow calls in a session have explore:true set, you are
   almost certainly using it wrong — switch to plain. Both modes stop at the
   first step that doesn't resolve or fails, so a flow that goes wrong is
   never worse than the step-by-step equivalent.
7. Once you've worked out how a site behaves (selectors, role/name pairs, a
   working flow sequence), save it with browser_save_skill so a future
   session doesn't pay the same discovery cost again — this is the whole
   point of splitting explore:true (discovery) from a plain run (cheap
   reuse). Check browser_list_skills first: update
   an existing skill for this domain rather than creating a near-duplicate.
   You don't need to do this for a one-off task on a site you'll never
   revisit — it's for anything you can reasonably expect to come back to.

Tool selection — this is important for anything you intend to report as a
verified UI behavior:
- browser_click / browser_type / browser_press_key / browser_run_flow: the
  ONLY tools that count as testing real user
  interaction. Prefer them whenever you're checking that a button, link, or
  form field actually works. Standalone click/type/press_key glide a
  visible cursor dot to the target and briefly outline it (violet for
  click, cyan for type/key) — a multi-step animation (glide, pause, press,
  ripple) that takes a couple of seconds per action — so a human watching
  the tab can actually follow what's happening instead of it jumping
  instantly between fields. This adds real latency; it's intentional, not a
  bug. Flow steps use a faster, lighter version of the same animation so a
  multi-step script doesn't take unreasonably long. browser_evaluate does
  none of this.
- browser_evaluate: for reading state (localStorage, computed values) or
  test setup/teardown (e.g. seeding an auth token). Do NOT use it to click
  buttons or fill fields as a shortcut — setting element.value via JS does
  not reliably trigger React/Vue's onChange, so a broken input can look
  like it works when it doesn't. If you used evaluate to fill a form, say
  so explicitly rather than reporting it as a tested interaction.
- browser_screenshot: pure visual inspection (layout, spacing, colors) when
  you need to see rendering issues the accessibility tree can't show.
- browser_snapshot({visual:true}): structure + visual grounding in one
  call, for when you need both an id to act on and confidence about its
  position.
- browser_start_recording / browser_stop_recording: when what matters is
  motion, not a single frame — a drag, an animation, a multi-step wizard you
  want to hand back as one video instead of a pile of screenshots. Bracket
  just the part you actually need recorded; don't leave a recording running
  across unrelated exploration.
- browser_inspect_element: browser_snapshot deliberately shows very little
  per element to stay cheap across a whole page. When you need to know WHY
  one specific element looks or behaves a certain way — which CSS rule set
  that color/spacing, what its computed layout is, whether it has a click/
  change listener attached — call browser_inspect_element on its id instead
  of trying to infer it from the snapshot or re-reading source files blind.
- browser_snapshot({selector:...}): the middle tier between a plain
  browser_snapshot (whole page, flat, cheap, but a form field's label can be
  50 unrelated elements away in the list) and browser_inspect_element (one
  element, no surrounding context). Pass a CSS selector for the containing
  form/panel/row and get back a nested tree of just what's inside it — a
  label and its field are siblings in the same "children" array, so the
  association is structural, not something you infer from ordering. Prefer
  this over a plain browser_snapshot when you're specifically trying to fill
  out or verify one form/section, and especially when browser_snapshot
  showed you fields with an empty name (no accessible label) that you need
  to correctly associate.
- browser_reading_mode: when the goal is reading content (an article, docs
  page, blog post), not acting on it — returns clean title+body text with
  the accessibility tree skipped entirely, cheaper than browser_snapshot for
  that specific job. Says so and returns nothing useful on non-article pages
  (an app UI, a dashboard) — fall back to browser_snapshot there.
- browser_find: when you already know what you're looking for (a label, an
  error message, a specific price) on a large page — jumps straight to
  matching elements (by text, CSS selector, or XPath) instead of you
  scanning a full browser_snapshot node list. Returns the same {i,r,n}
  shape as browser_snapshot, usable directly with browser_click/
  browser_type.

Both browser_screenshot and browser_snapshot({visual:true}) save the image to a file
on disk and give you the path in the text output. Inline image content is
OFF by default (set BROWSERCONTROL_INLINE_IMAGES=true to enable) because
some MCP clients — notably some Antigravity CLI versions — can't handle
image content from MCP servers, and a mishandled screenshot risks landing in
your context as raw base64 text: a single ~700KB PNG is roughly 230k tokens
that way. This is not hypothetical — it has burned a large chunk of a 5-hour
usage window in practice. Concretely:
- Never pass format:"png" unless you specifically need pixel-exact color
  values — it is 3-5x larger than the jpeg default for no benefit in
  routine "let me see the page" checks.
- Don't call browser_screenshot / browser_snapshot({visual:true}) on every step.
  Use browser_snapshot (cheap, text-only) as your default; reach for a
  screenshot only when you actually need to visually confirm layout/styling
  or ground an ambiguous click target.
- If your client doesn't render inline images, read the saved file path
  rather than re-requesting the screenshot hoping it renders differently.

Inspecting the network call behind a submit/action button (like the DevTools
Network tab):
1. browser_network_clear right before the click, so old page-load requests
   don't drown out the one you care about.
2. browser_click the submit/action button.
3. browser_network_requests to see what fired — defaults to XHR/Fetch/
   Document/WebSocket only (the actual API calls), not static assets.
4. browser_network_requests again with requestId set (from that list) if
   you need the full request/response headers or body (e.g. to check the
   payload sent or the error message returned).
The network log also auto-clears on every browser_navigate.

browser_run_flow (either mode) blocks a step by default if its target's
accessible name looks destructive/irreversible (delete, remove, cancel, sign
out, pay, confirm, ...) — the response will have reason:"risky_action_blocked"
and a message naming the step. This tool has no way to ask your user directly,
so that's your job: surface the blocked step to your user, and only re-run
with that step's confirmRisky:true once they've confirmed it's intended.
Don't set confirmRisky:true reflexively just to get the flow to complete.

Once a browser_run_flow sequence is validated and working, browser_save_flow
persists it (name + the same steps array) as a reusable flow — it then shows
up with a Run button in the extension's side panel, so a human can re-run it
without you. Save one when you've worked out something worth re-running
later (a login flow, a recurring form), not for a one-off sequence you'll
never use again. Check browser_list_flows first and pass that flow's id
back to browser_save_flow to update it instead of creating a near-duplicate.

If a command times out or errors, check the returned "hint" field before
retrying blindly — it usually points at the actual cause (stale node id,
extension not connected, unhandled dialog, etc).
`.trim(),
});

// Input schema for browser_run_flow — the same step list regardless of
// explore mode, which just reports back differently (see runFlowSteps in
// lib/flow.ts, the single engine behind both).
// Spread into every tab-scoped tool's inputSchema.properties — lets a
// caller target a SPECIFIC tab (its id comes back from browser_navigate or
// browser_list_tabs) instead of whichever one browser_switch_tab last
// pointed at. Omitting it keeps every existing single-tab flow unchanged.
const TAB_ID_PROPERTY = {
  tabId: { type: "number", description: "Target this specific tab (id from browser_navigate's response or browser_list_tabs) instead of the currently active one. Omit to use the current tab, same as always." },
} as const;

// Shared between browser_run_flow's inputSchema and browser_save_flow's —
// a saved flow is the exact same FlowStep[] shape run_flow already runs, so
// the two tool schemas describe steps identically rather than drifting.
const FLOW_STEP_ITEM_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "type", "press_key", "wait_for", "assert_text", "scroll", "drag"] },
    role: { type: "string", description: "Accessibility role of the target, from a prior browser_snapshot (e.g. 'button', 'textbox')." },
    name: { type: "string", description: "Accessible name of the target, paired with role." },
    selector: { type: "string", description: "CSS selector, as an alternative to role+name." },
    text: { type: "string", description: "Text to type (action: 'type')." },
    key: { type: "string", description: "Key to press (action: 'press_key') — a named key or a single character, see browser_press_key." },
    contains: { type: "string", description: "Substring the target's accessible name must contain (action: 'assert_text')." },
    deltaX: { type: "number", description: "Scroll delta (action: 'scroll')." },
    deltaY: { type: "number", description: "Scroll delta (action: 'scroll')." },
    fromX: { type: "number", description: "Drag start x, viewport pixels (action: 'drag')." },
    fromY: { type: "number", description: "Drag start y, viewport pixels (action: 'drag')." },
    toX: { type: "number", description: "Drag end x, viewport pixels (action: 'drag')." },
    toY: { type: "number", description: "Drag end y, viewport pixels (action: 'drag')." },
    timeoutMs: { type: "number", description: "Max time in ms to poll for the target to appear (action: 'wait_for'), default 3000." },
    confirmRisky: { type: "boolean", description: "Set true to proceed past a step whose target looks destructive/irreversible (delete, cancel, sign out, pay, confirm, ...) — only after confirming with your user that this step is intended." },
  },
  required: ["action"],
} as const;

// Mirrors flow.ts's runtime `needsTarget`/resolveStepTarget logic — a step
// that needs a target but has neither a selector nor a complete role+name
// pair will resolve to null every single time it runs (role alone or name
// alone doesn't match anything: lib/flow.ts's resolveStepTarget requires
// `step.role && step.name` both truthy). Catching that here, at save time,
// turns a flow that's silently DOA into an immediate, specific error
// instead of a confusing "found no element matching X" only discovered
// whenever someone finally hits Run in the panel.
function findBadFlowStep(
  steps: FlowStep[],
): { index: number; reason: string } | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const needsTarget =
      step.action !== "scroll" &&
      step.action !== "drag" &&
      !(step.action === "press_key" && !step.role && !step.selector);
    if (!needsTarget) continue;
    const hasSelector = typeof step.selector === "string" && step.selector.trim() !== "";
    const hasRoleName =
      typeof step.role === "string" && step.role.trim() !== "" &&
      typeof step.name === "string" && step.name.trim() !== "";
    if (hasSelector || hasRoleName) continue;
    const reason =
      step.role && !hasRoleName
        ? `has role "${step.role}" but no (or empty) name`
        : step.name && !hasRoleName
          ? `has name "${step.name}" but no role`
          : "has neither a selector nor a role+name pair";
    return { index: i, reason };
  }
  return null;
}

const FLOW_STEPS_SCHEMA = {
  type: "object",
  properties: {
    ...TAB_ID_PROPERTY,
    explore: { type: "boolean", description: "Add a per-step delta (what changed) to validate an unfamiliar/best-guess sequence once, instead of a plain run. See the tool description — don't default to this once a flow is validated." },
    steps: {
      type: "array",
      description: "Ordered list of steps to run in one call. Stops at the first step that doesn't resolve or fails.",
      items: FLOW_STEP_ITEM_SCHEMA,
    },
  },
  required: ["steps"],
} as const;

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browser_navigate",
        description: "Navigate to a URL. By default reuses whichever tab is currently active (today's behavior, unchanged). Pass newTab:true to open this URL in a NEW tab instead, keeping the current one where it is — the response's `tabId` is then what you pass as `tabId` on later browser_click/browser_snapshot/etc. calls to keep driving that specific tab. Pass an existing `tabId` to re-navigate that specific tab in place.",
        inputSchema: { type: "object", properties: { url: { type: "string" }, newTab: { type: "boolean", description: "Open in a new tab instead of reusing the current one. Ignored if tabId is set." }, tabId: { type: "number", description: "Re-navigate this specific existing tab (id from a prior browser_navigate/browser_list_tabs) instead of the current one or a new one." } }, required: ["url"] }
      },
      {
        name: "browser_list_tabs",
        description: "List tabs currently in the \"🤖 AI Workspace\" tab group — including tabs the USER dragged in themselves, not just the one you navigated to. Each entry has isNew:true if it wasn't there the last time you called this. Call this at the start of a session, or whenever the user references a tab they already have open (\"check this\", \"I put a page there\") — that's the only way you'll find out about it, since there's no other notification channel. Use browser_switch_tab to start working on one of the results.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_switch_tab",
        description: "Make an existing tab (from browser_list_tabs) the active one for all subsequent commands (browser_snapshot, browser_click, etc.), instead of browser_navigate-ing to the same URL fresh. Use this to start working on a tab the user handed you.",
        inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] }
      },
      {
        name: "browser_list_skills",
        description: "List saved skills — durable notes on how to work with a specific site (working selectors, role/name pairs, flow sequences), each declaring which domain(s) it applies to. Metadata only (name/domains/description), never the full skill content, so this stays cheap even as the skill count grows. Check this before creating a new skill (to update an existing one instead of duplicating it), or when the user references a skill by name (\"use the github skill\") without having navigated there yet. browser_navigate also auto-surfaces a matching skill via a skillHint field, so you don't usually need to call this just to check the current page. Pass `domain` or `query` once you have more than a handful of skills saved, so you're not re-reading every skill's metadata just to find the one you want.",
        inputSchema: { type: "object", properties: { domain: { type: "string", description: "Exact hostname match, e.g. \"github.com\" — the same lookup browser_navigate's skillHint uses internally." }, query: { type: "string", description: "Substring match against name/description/domains, for when you don't know the exact hostname." } } }
      },
      {
        name: "browser_save_skill",
        description: "Create or update a skill — persist REUSABLE interaction knowledge about a site (working selectors, role/name pairs, a flow sequence, gotchas) so a future session doesn't have to re-discover it from scratch. This is what makes browser_run_flow's explore:true discovery cost a one-time cost instead of a recurring one. Do NOT call this just because you navigated somewhere or read a page — that's what browser_reading_mode/browser_select_content/browser_batch_crawl/browser_deep_crawl are for, and none of them need a skill; save one only when you've actually worked out how to interact with the site (a login flow, a search form, a multi-step wizard) and expect to come back to it. `name` is a lowercase slug (e.g. \"github\", \"mio-fe-admin-inquiries\"); `domains` is required when creating a new skill (e.g. [\"github.com\"]) so browser_navigate can find it later, and can be omitted when updating one that already has domains set. This always overwrites the full file — check browser_list_skills or just read the existing skills/<name>/SKILL.md first if updating, and pass back the complete content, not a partial diff. If a new skill's domains overlap an existing one, the response carries a `_duplicateWarning` — merge into the existing skill instead of keeping both when you see it.",
        inputSchema: { type: "object", properties: { name: { type: "string" }, domains: { type: "array", items: { type: "string" } }, description: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] }
      },
      {
        name: "browser_snapshot",
        description: "Get the interactive elements on the page — the default way to see what's there before clicking/typing. Plain call: a flat text list, {i, r, n, v?} per entry (i=node id for browser_click/browser_type/browser_inspect_element, r=role, n=accessible name, v=current value if any). Fast and cheap, but you can't see WHERE on screen an id is or how fields relate to their labels — two optional modes cover those: `visual:true` also returns a screenshot with a numbered box over every interactive element (same ids) — use before clicking anything you're not 100% sure about (custom dropdowns, icon-only buttons, ambiguous labels). `selector:\"...\"` scopes to one container (a form/panel/row) and returns a NESTED tree instead of a flat list — a field's label ends up as its sibling in the same `children` array, so the association is structural instead of guessed from position; capped at 150 elements, narrow the selector if truncated. If both are set, visual wins (full-page annotated screenshot) — selector-scoped + visual together isn't supported, pass selector alone for the nested tree.",
        inputSchema: { type: "object", properties: { visual: { type: "boolean", description: "Also return an annotated screenshot with numbered boxes over interactive elements." }, selector: { type: "string", description: "CSS selector to scope into — returns a nested tree instead of the default flat list." }, ...TAB_ID_PROPERTY } }
      },
      {
        name: "browser_click",
        description: "Click an element by its Node ID (from browser_snapshot). Dispatches a real, trusted mouse event — use this instead of browser_evaluate whenever you're testing that a button/link/control actually works, since a JS-invoked .click() or a manually-set .value doesn't exercise the same code path a real user click does.",
        inputSchema: { type: "object", properties: { nodeId: { type: "number" }, ...TAB_ID_PROPERTY }, required: ["nodeId"] }
      },
      {
        name: "browser_type",
        description: "Focus the element with the given Node ID (from browser_snapshot) and type text into it as a real user would, one CDP input event at a time. Prefer this over browser_evaluate for filling form fields — setting element.value via JS does not reliably trigger React/Vue's onChange, so it can make a broken input look like it works.",
        inputSchema: { type: "object", properties: { text: { type: "string" }, nodeId: { type: "number", description: "Element to focus before typing. Omit only if the target is already focused." }, ...TAB_ID_PROPERTY }, required: ["text"] }
      },
      {
        name: "browser_press_key",
        description: "Press a key — dispatches a real keydown/keyup, distinct from browser_type which only inserts text and never submits or triggers shortcuts on its own. Two forms: a named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown) for form/navigation use — after browser_type to submit a search box or form (Enter), or to navigate a custom dropdown/menu (arrows + Enter); or a single character (a letter, digit, or common symbol, e.g. \"r\") to trigger a keyboard-shortcut listener directly — canvas/whiteboard apps (Excalidraw and similar) commonly bind their tool selection to single letters rather than exposing DOM buttons for each one, since there's no per-shape DOM to click. Single characters fire the key event only, never insert text (use browser_type for that).",
        inputSchema: { type: "object", properties: { key: { type: "string", description: "A named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Home, End, PageUp, PageDown), or any single character." }, nodeId: { type: "number", description: "Element to focus before pressing the key. Omit only if the target is already focused (e.g. right after browser_type), or for a global/canvas shortcut with no specific element to focus." }, ...TAB_ID_PROPERTY }, required: ["key"] }
      },
      {
        name: "browser_run_flow",
        description: "Run a list of steps (click/type/press_key/drag/wait_for/assert_text/scroll) in ONE call instead of one round trip per step — collapses a multi-step flow (login, a multi-field form, a wizard, drawing a diagram) that would otherwise cost N separate tool calls into a single one. Steps target elements by role+name (from a prior browser_snapshot) or a CSS selector, resolved fresh against the live page at execution time — except drag, addressed by raw viewport coordinates since canvas-based UI has no per-shape DOM element. Stops at the first step that doesn't resolve or fails, and returns a compact per-step report plus a final snapshot. Two modes: plain (default) is for a sequence you're already confident in, one clean run. `explore:true` adds a `delta` (added/changed/removed elements vs. the previous step, not a full snapshot) to every step's result — use it ONCE to validate a best-guess sequence against an unfamiliar UI (confirm role/name guesses, see what each step actually changed) before switching back to plain mode for repeat runs; it is NOT a safe preview — every step still has the same real side effects (submitting a form, following a link, drawing a shape), there's no way to know a later step's UI without actually executing the earlier ones. Don't default to explore:true once a sequence is validated — repeated explore calls for a flow you already know works is the most common way this tool burns tokens unnecessarily. A step whose target looks destructive/irreversible (delete, cancel, sign out, pay, confirm, ...) is blocked by default in both modes; if that's actually intended, confirm with your user and re-run with that step's confirmRisky:true.",
        inputSchema: FLOW_STEPS_SCHEMA,
      },
      {
        name: "browser_save_flow",
        description: "Persist a step sequence (same shape as browser_run_flow's `steps`) as a named, reusable flow — so it shows up in the extension's side panel with a Run button, instead of only existing inline in the one browser_run_flow call that used it. Validate the sequence first (browser_explore_flow or a plain browser_run_flow that actually succeeded) before saving it — this does not run the steps, only stores them. Pass an existing flow's `id` to overwrite it (e.g. after fixing a broken step) instead of creating a near-duplicate; omit `id` to create a new one.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Existing flow id to overwrite. Omit to create a new flow." },
            name: { type: "string", description: "Human-readable name shown in the side panel." },
            description: { type: "string" },
            domain: { type: "string", description: "Hostname this flow targets (e.g. \"github.com\") — shown as a badge in the panel, and usable as a filter with browser_list_flows." },
            steps: { type: "array", items: FLOW_STEP_ITEM_SCHEMA },
          },
          required: ["name", "steps"],
        },
      },
      {
        name: "browser_list_flows",
        description: "List saved flows — metadata only (id, name, description, domain, step count), same cheap-list shape as browser_list_skills. Use before browser_save_flow to check whether a similar flow already exists (update it instead of duplicating), or to find a flow's id.",
        inputSchema: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Only list flows saved with this domain." },
          },
        },
      },
      {
        name: "browser_delete_flow",
        description: "Delete a saved flow by id (from browser_list_flows) — removes it from storage and from the extension's side panel. Use this to clean up a flow that turned out broken (e.g. a step whose role/name no longer resolves) instead of leaving it cluttering the panel; the human can also delete it directly from the panel.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "browser_evaluate",
        description: "Evaluate arbitrary JavaScript on the page. Use this for reading state (e.g. localStorage, computed values) or for setup/teardown (e.g. seeding auth tokens) — NOT as a shortcut for clicking buttons or filling form fields, which won't verify real user interaction. Use browser_click/browser_type for anything you intend to report as a tested UI behavior.",
        inputSchema: { type: "object", properties: { expression: { type: "string" }, ...TAB_ID_PROPERTY }, required: ["expression"] }
      },
      {
        name: "browser_scroll",
        description: "Scroll the page by a pixel delta",
        inputSchema: { type: "object", properties: { deltaX: { type: "number" }, deltaY: { type: "number" }, ...TAB_ID_PROPERTY } }
      },
      {
        name: "browser_drag",
        description: "Drag from one viewport point to another — a real mousedown->mousemove(*n)->mouseup sequence, not a click. For canvas-based UI (a whiteboard, a drawing app) where there's no DOM element per shape to click/type into: drawing a rectangle/line, resizing something, reordering a drag-handle list. Coordinates are viewport pixels (from browser_snapshot({visual:true})'s annotated screenshot, or worked out from browser_evaluate reading canvas/element bounds) — there's no nodeId for a point on a canvas the way there is for a DOM element.",
        inputSchema: { type: "object", properties: { fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" }, ...TAB_ID_PROPERTY }, required: ["fromX", "fromY", "toX", "toY"] }
      },
      {
        name: "browser_network_requests",
        description: "List network requests observed since the last navigate or browser_network_clear — like the DevTools Network tab. Plain call: defaults to XHR/Fetch/Document/WebSocket only (the calls an action button actually triggers), hiding static asset noise (images/css/fonts/scripts) unless you pass resourceTypes explicitly. Use browser_network_clear right before clicking a submit/action button, then call this after, to see exactly what request that click caused. Pass `requestId` (from a prior call's results) instead to get full detail on that ONE request — headers, post body, response body (fetched on demand, truncated if large) — ignoring resourceTypes/filter/limit.",
        inputSchema: {
          type: "object",
          properties: {
            resourceTypes: { type: "array", items: { type: "string" }, description: "CDP resource type names (XHR, Fetch, Document, Script, Stylesheet, Image, Font, Media, WebSocket, ...). Overrides the default filter." },
            filter: { type: "string", description: "Only include requests whose URL contains this substring" },
            limit: { type: "number", description: "Max entries to return, most recent first. Default 50." },
            requestId: { type: "string", description: "Get full detail for this one request instead of listing — id comes from a prior browser_network_requests call's results." },
            ...TAB_ID_PROPERTY
          }
        }
      },
      {
        name: "browser_network_clear",
        description: "Clear the network log. Call this immediately before a submit/action click so browser_network_requests afterward only shows what that action triggered, not accumulated page-load noise. Also happens automatically on every browser_navigate.",
        inputSchema: { type: "object", properties: { ...TAB_ID_PROPERTY } }
      },
      {
        name: "browser_inspect_element",
        description: "Deep-dive on ONE element by id (from browser_snapshot): outerHTML, which CSS rule/selector set its computed styles, key computed layout properties, and any event listeners attached (type only, not handler source). Expensive relative to browser_snapshot — use it only for the specific element you need to explain, not in a loop over every node.",
        inputSchema: { type: "object", properties: { nodeId: { type: "number" }, ...TAB_ID_PROPERTY }, required: ["nodeId"] }
      },
      {
        name: "browser_reading_mode",
        description: "Extract just the clean article/main-content text of the page (title + body text, chrome like nav/ads/sidebars stripped) — like a browser's built-in reader view. Far cheaper than browser_snapshot when the goal is READING content (an article, a docs page, a blog post) rather than acting on interactive elements: no accessibility tree, no node ids, just text. If the page isn't article-shaped (an app UI, a form, a dashboard), it'll say so — fall back to browser_snapshot for those.",
        inputSchema: { type: "object", properties: { maxChars: { type: "number", description: "Cap on returned text length, default 20000. Lower it if you only need a quick sense of the page, not the full article." }, ...TAB_ID_PROPERTY } }
      },
      {
        name: "browser_find",
        description: "Find elements matching text, a CSS selector, or an XPath — like Ctrl+F, but returns node ids (usable with browser_click/browser_type/browser_inspect_element) instead of just scrolling to a match. Much cheaper than browser_snapshot when you already know what you're looking for (a specific label, error message, or product name) on a large/data-heavy page — jump straight to it instead of scanning the whole node list. Flashes a highlight on the first match, same as browser_click's target highlight.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Text, CSS selector, or XPath to search for." }, limit: { type: "number", description: "Max matches to return, default 20." }, ...TAB_ID_PROPERTY }, required: ["query"] }
      },
      {
        name: "browser_select_content",
        description: "Extract clean markdown (headings, links, lists, code blocks, emphasis preserved) from specific element(s) — for crawling a page (or many pages, across many calls) into material for doc generation. IMPORTANT: this does NOT return the extracted content in the tool response — that would flood your context on anything beyond a trivial page, especially across a multi-page crawl. Every matched element is instead saved as its own docs block (SQLite-backed, see browser_query_docs) and you get back the new block id(s) plus a short preview. Use browser_query_docs({action:'read', blockId}) once you're ready to use one, or {action:'search'} to find the right one across everything saved this session (or every session, with allSessions:true). Pass either `selector` (CSS — matches multiple elements, each becomes its own block, e.g. every '.faq-item') or `nodeId` (from browser_snapshot/browser_find — exactly one element). If you truly need a small amount of text back immediately instead of saving blocks, browser_reading_mode is the right tool, not this one.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector — every matching element becomes its own extracted block." },
            nodeId: { type: "number", description: "A specific node id (from browser_snapshot/browser_find) to extract instead of a selector." },
            maxChars: { type: "number", description: "Cap on characters extracted THIS call (not the file total), default 20000." },
            maxMatches: { type: "number", description: "Max elements to extract when using selector, default 20." },
            ...TAB_ID_PROPERTY
          }
        }
      },
      {
        name: "browser_batch_crawl",
        description: "Concurrent batch crawler for heavy workloads: fetch and extract clean Markdown from multiple URLs in parallel without opening visible tabs or triggering UI animations. Automatically extracts metadata (Title, Author, Published Date, Reading Time) and outbound links, applies Readability heuristics, dedupes against every URL already crawled this session, and saves each page as its own docs block (SQLite-backed — see browser_query_docs), not one file everything gets appended to. Returns a compact execution summary and the new block ids to save tokens — never the extracted content itself. IMPORTANT: unlike every other browser_* tool, this does NOT go through the real browser tab — it's a plain fetch() with no cookies/login session and no JavaScript execution. Only use it for public, mostly-static pages (docs, blog posts, wikis). For anything behind a login, or a JS-rendered SPA, navigate there with browser_navigate and use browser_select_content/browser_reading_mode on the real tab instead (or browser_start_job for several such pages) — this tool will silently return thin or empty results there, not an error. Max 100 URLs per call; split a larger list across multiple calls. For recursively following the links a crawl turns up instead of managing that yourself, use browser_deep_crawl instead of calling this in a loop.",
        inputSchema: {
          type: "object",
          properties: {
            urls: { type: "array", items: { type: "string" }, description: "Array of URLs to crawl concurrently (max 100 per call)." },
            concurrency: { type: "number", description: "Number of parallel workers. Default scales with this machine's CPU core count (roughly cores x4, floor 8, ceiling 32) — set explicitly only if you need a specific number." },
            maxCharsPerUrl: { type: "number", description: "Cap on characters extracted per URL, default 15000." }
          },
          required: ["urls"]
        }
      },
      {
        name: "browser_search",
        description: "Run a web search and get back clean {title, url, snippet} results — not a page you then have to parse yourself. Use this to find URLs worth crawling (feed the results into browser_batch_crawl/browser_start_job/browser_deep_crawl) instead of navigating to a search engine and treating the results page itself as content. Same fetch()-based mechanism as browser_batch_crawl (no login session, no JS) via DuckDuckGo's HTML endpoint.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", description: "Max results, default 10 (max 30)." } }, required: ["query"] }
      },
      {
        name: "browser_deep_crawl",
        description: `Recursive crawl: start from seed URLs and/or a search query, follow the outbound links pages turn up, up to \`depth\` hops deep — automatically, without you reading content to decide what to follow next. A continuous pool of \`concurrency\` workers drains a shared queue (a real frontier, not depth-by-depth batches) — a worker that finishes a page immediately picks up whatever's next, sibling or freshly-discovered child, so the whole pool stays busy instead of the next round waiting on this round's single slowest page. Built on browser_batch_crawl's per-page fetch (same fetch()-based, no-login caveat applies), so it's for discovering/reading public content at volume, not for authenticated or JS-rendered sites. Returns a crawlId almost immediately; the crawl runs in the background. Poll browser_task_status(crawlId) — each call only reports pages that finished since your last check. Each page is saved as its own docs block as it finishes (query via browser_query_docs — a crawl of hundreds of pages does NOT become one giant file); this tool never returns crawled content directly. Max depth ${MAX_CRAWL_DEPTH}, max ${MAX_CRAWL_PAGES} total pages per crawl, ${MAX_CONCURRENT_CRAWLS} crawls running at once.`,
        inputSchema: {
          type: "object",
          properties: {
            seedUrls: { type: "array", items: { type: "string" }, description: "Root URLs to start from. Provide this, searchQuery, or both." },
            searchQuery: { type: "string", description: "Run browser_search first and use its results as additional depth-0 roots." },
            depth: { type: "number", description: `How many hops of outbound links to follow, default 2 (max ${MAX_CRAWL_DEPTH}). Depth 1 = just the seeds/search results, no following.` },
            maxPages: { type: "number", description: `Total page budget across the whole crawl, default 60 (max ${MAX_CRAWL_PAGES}).` },
            maxOutlinksPerPage: { type: "number", description: "Cap on how many outbound links ONE page can add to the frontier, default 15 (max 50) — controls fan-out, not total volume (maxPages does that)." },
            concurrency: { type: "number", description: "Persistent workers draining the crawl queue at once. Default scales with this machine's CPU core count (roughly cores x4, floor 8, ceiling 48/hard cap 64) — set explicitly only if you need a specific number." },
            maxCharsPerUrl: { type: "number", description: "Cap on characters extracted per URL, default 15000." },
          },
        }
      },
      {
        name: "browser_start_job",
        description: `Async multi-tab task runner: give it a list of URLs (each with what to extract), it opens up to \`concurrency\` real BACKGROUND tabs at once — full login session, full JS rendering, unlike browser_batch_crawl — works through each, and saves each page's result as its own docs block (query via browser_query_docs) as they finish. These tabs never touch your foreground session: they don't steal window focus and won't become the default target for a browser_click/browser_snapshot call that omits tabId. Returns almost immediately with a jobId; the crawl continues in the background. Poll browser_task_status(jobId) to check progress — do NOT block waiting for this to "complete" the way a normal tool call does, that's the whole point of it being async. Prefer this over several sequential browser_navigate+browser_reading_mode calls whenever you have multiple URLs to process — driving them one at a time is exactly the throughput problem this exists to avoid. Max ${MAX_JOB_TASKS} tasks per job, ${MAX_CONCURRENT_JOBS} jobs running at once; split a larger batch across sequential browser_start_job calls.`,
        inputSchema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: `1-${MAX_JOB_TASKS} pages to process concurrently.`,
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  extract: { type: "string", enum: ["reading_mode", "select_content", "snapshot"], description: "What to do on each page once loaded — 'reading_mode' (default): clean article text, for reading/summarizing. 'select_content': markdown from a specific selector (pass `selector` too), for doc generation. 'snapshot': the interactive-element list, if the point is finding something actionable per page rather than reading it." },
                  selector: { type: "string", description: "CSS selector — only used when extract is 'select_content'." },
                },
                required: ["url"],
              },
            },
            concurrency: { type: "number", description: "Tabs to run at once, default 4 (max 8). Real tabs are heavier than browser_batch_crawl's fetch workers — keep this modest." },
          },
          required: ["tasks"],
        },
      },
      {
        name: "browser_task_status",
        description: "Check progress on an async task — a jobId from browser_start_job OR a crawlId from browser_deep_crawl, this tool tells them apart automatically. IMPORTANT: each call only returns results that finished since the LAST time you checked THIS id — already-reported results are never repeated, so don't expect the full list again on a second call. Keep polling until the summary says complete. A completed task is dropped from tracking the moment you've seen its last result, so don't call this again after that — the id will just come back as unknown.",
        inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      },
      {
        name: "browser_query_docs",
        description: "Query content saved by browser_select_content/browser_batch_crawl/browser_deep_crawl/browser_start_job — each of those saves what it extracts as one or more docs BLOCKS (SQLite-backed, not a file you read yourself) instead of returning the content directly. Three actions: 'list' — cheap metadata only (id, source, title, char count) for blocks in scope, so you can see what's there before fetching anything; 'read' — full content of ONE block by `blockId`; 'search' — full-text search across blocks' content/title/source, returning a highlighted snippet per match (not full content) so you can find the right block before reading it. Defaults to the CURRENT session's blocks only; pass `allSessions:true` to search/list across every session ever recorded (e.g. \"did I already crawl this site last week\").",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "search", "read"] },
            blockId: { type: "number", description: "Required for action:'read' — id from a prior 'list' or 'search' result." },
            query: { type: "string", description: "Required for action:'search' — full-text query." },
            allSessions: { type: "boolean", description: "For 'list'/'search': include every session's blocks, not just the current one. Default false." },
            limit: { type: "number", description: "Max results for 'list'/'search', default 20/50." },
          },
          required: ["action"],
        },
      },
      {
        name: "browser_close_tab",
        description: "Close a tab by id (from browser_navigate/browser_list_tabs) — tidy up a tab you opened with browser_navigate({newTab:true}) once you're done with it, especially after driving several tabs at once.",
        inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
      },
      {
        name: "browser_screenshot",
        description: "Capture a screenshot so you can visually inspect layout, styling, spacing, and rendering issues that the accessibility snapshot (text-only) can't show",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport" },
            format: { type: "string", enum: ["jpeg", "png"], description: "Leave unset (defaults to jpeg). PNG is 3-5x larger for typical UI screenshots and is almost never worth it — only pass 'png' if you specifically need pixel-exact color values, not for routine 'let me see the page' checks." },
            quality: { type: "number", description: "JPEG quality 0-100, default 80" },
            ...TAB_ID_PROPERTY
          }
        }
      },
      {
        name: "browser_start_recording",
        description: "Start recording the active tab as video — use this instead of repeated browser_screenshot calls when you want to show/review a multi-step flow (a wizard, a drag interaction, an animation) as motion rather than a stack of stills. Records the tab only (no audio, no other tabs). Call browser_stop_recording when done; every tool call you make while recording is running still lands in the normal session log (data/logs/session-*.jsonl) with a timestamp, so you can line up what you did against what the video shows. Only one recording can be active at a time.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_stop_recording",
        description: "Stop the recording started by browser_start_recording, save it as a .webm file, and return its path. Errors if no recording is in progress.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "browser_set_session_name",
        description: "Label this daemon session with a short human-readable name (e.g. \"Debugged checkout flow on shop.example.com\") so `mise run data:sessions`/`data:show` can identify it later instead of just a timestamp. Without this, a session's name auto-fills from the hostnames it visited — call this when that's not descriptive enough (e.g. you did something specific worth remembering on a generic site). Not required for every session; it's a nicety for ones worth finding again.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      }
    ]
  };
});

async function handleToolCall(request: CallToolRequest): Promise<ToolCallResponse> {
  const { name, arguments: args } = request.params;
  try {
    let result: CommandResult | string;
    switch (name) {
      case "browser_navigate": {
        result = await executeCommand("navigate", { url: args?.url, newTab: args?.newTab, tabId: args?.tabId });
        const url = typeof args?.url === "string" ? args.url : undefined;
        if (url) {
          try {
            const hostname = new URL(url).hostname;
            dataStore.recordHostVisit(SESSION_ID, hostname);
            const skill = findSkillForHostname(hostname);
            if (skill) result = { ...result, skillHint: `Skill available for this domain: ${skill.path} — read it before exploring.` };
          } catch {}
        }
        break;
      }
      case "browser_list_tabs":
        result = await executeCommand("list_tabs");
        break;
      case "browser_switch_tab":
        result = await executeCommand("switch_tab", { tabId: args?.tabId });
        break;
      case "browser_list_skills":
        result = { skills: listSkills({ domain: args?.domain as string | undefined, query: args?.query as string | undefined }) };
        break;
      case "browser_save_skill":
        result = saveSkill(args ?? {});
        break;
      case "browser_snapshot": {
        // visual wins if both are set — see the tool description for why
        // selector+visual together isn't supported.
        if (args?.visual) {
          const snap = await executeCommand("visual_snapshot", { tabId: args?.tabId });
          if (!snap?.dataBase64) {
            return {
              content: [{ type: "text", text: `Error: ${snap?.error ?? 'Visual snapshot failed'}${snap?.hint ? ` (${snap.hint})` : ''}` }],
              isError: true,
            };
          }
          const snapFilePath = saveScreenshotToFile(snap.dataBase64 as string, 'jpeg');
          return {
            content: [
              ...(INLINE_IMAGES ? [{ type: "image" as const, data: snap.dataBase64 as string, mimeType: 'image/jpeg' }] : []),
              { type: "text", text: `${snap.message}\nScreenshot saved to ${snapFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to see the annotated boxes; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${snap._flowWarning ? `\n\n[${snap._flowWarning}]` : ''}\n\n${JSON.stringify(snap.nodes, null, 2)}` },
            ],
          };
        }
        result = args?.selector
          ? await executeCommand("query_region", { selector: args.selector, tabId: args?.tabId })
          : await executeCommand("snapshot", { tabId: args?.tabId });
        break;
      }
      case "browser_click":
        result = await executeCommand("click", { nodeId: args?.nodeId, tabId: args?.tabId });
        break;
      case "browser_type":
        result = await executeCommand("type", { text: args?.text, nodeId: args?.nodeId, tabId: args?.tabId });
        break;
      case "browser_press_key":
        result = await executeCommand("press_key", { key: args?.key, nodeId: args?.nodeId, tabId: args?.tabId });
        break;
      case "browser_run_flow":
        result = await executeCommand(args?.explore ? "explore_flow" : "run_flow", { steps: args?.steps, tabId: args?.tabId });
        break;
      case "browser_save_flow": {
        const name = typeof args?.name === "string" ? args.name : "";
        const steps = Array.isArray(args?.steps) ? args.steps : undefined;
        if (!name || !steps || steps.length === 0) {
          return {
            content: [{ type: "text", text: `Error: Missing name or steps (hint: browser_save_flow needs a non-empty \`name\` and a non-empty \`steps\` array, same shape as browser_run_flow.)` }],
            isError: true,
          };
        }
        const badStep = findBadFlowStep(steps as FlowStep[]);
        if (badStep) {
          const badAction = (steps as FlowStep[])[badStep.index].action;
          return {
            content: [{ type: "text", text: `Error: Step ${badStep.index} (${badAction}) ${badStep.reason} — it will never resolve at run time (role alone or name alone never matches anything). Re-check against a fresh browser_snapshot/browser_explore_flow and pass a complete role+name pair or a CSS selector before saving.` }],
            isError: true,
          };
        }
        const saved = dataStore.saveFlow({
          id: typeof args?.id === "string" ? args.id : undefined,
          name,
          description: typeof args?.description === "string" ? args.description : undefined,
          domain: typeof args?.domain === "string" ? args.domain : undefined,
          steps: steps as FlowStep[],
        });
        result = { ...saved, message: `Saved flow "${saved.name}" (id ${saved.id}) — it now shows up in the extension's side panel.` };
        break;
      }
      case "browser_list_flows":
        result = { flows: dataStore.listFlows({ domain: args?.domain as string | undefined }) };
        break;
      case "browser_delete_flow": {
        const id = typeof args?.id === "string" ? args.id : "";
        if (!id) {
          return {
            content: [{ type: "text", text: `Error: Missing id (hint: get it from browser_list_flows).` }],
            isError: true,
          };
        }
        const deleted = dataStore.deleteFlow(id);
        result = deleted
          ? { success: true, message: `Deleted flow ${id}.` }
          : { error: `No flow with id "${id}"`, hint: "Call browser_list_flows again — it may already be deleted." };
        break;
      }
      case "browser_evaluate":
        result = await executeCommand("evaluate", { expression: args?.expression, tabId: args?.tabId });
        break;
      case "browser_scroll":
        result = await executeCommand("scroll", { deltaX: args?.deltaX, deltaY: args?.deltaY, tabId: args?.tabId });
        break;
      case "browser_drag":
        result = await executeCommand("drag", { fromX: args?.fromX, fromY: args?.fromY, toX: args?.toX, toY: args?.toY, tabId: args?.tabId });
        break;
      case "browser_network_requests":
        result = args?.requestId
          ? await executeCommand("network_request_detail", { requestId: args.requestId, tabId: args?.tabId })
          : await executeCommand("network_requests", { resourceTypes: args?.resourceTypes, filter: args?.filter, limit: args?.limit, tabId: args?.tabId });
        break;
      case "browser_network_clear":
        result = await executeCommand("network_clear", { tabId: args?.tabId });
        break;
      case "browser_inspect_element":
        result = await executeCommand("inspect_element", { nodeId: args?.nodeId, tabId: args?.tabId });
        break;
      case "browser_reading_mode":
        result = await executeCommand("reading_mode", { maxChars: args?.maxChars, tabId: args?.tabId });
        break;
      case "browser_find":
        result = await executeCommand("find", { query: args?.query, limit: args?.limit, tabId: args?.tabId });
        break;
      case "browser_select_content": {
        const sel = await executeCommand("select_content", {
          selector: args?.selector,
          nodeId: args?.nodeId,
          maxChars: args?.maxChars,
          maxMatches: args?.maxMatches,
          tabId: args?.tabId,
        });
        if (sel?.error) {
          return {
            content: [{ type: "text", text: `Error: ${sel.error}${sel.hint ? ` (${sel.hint})` : ''}` }],
            isError: true,
          };
        }
        const blocks = (sel?.blocks as string[] | undefined) ?? [];
        if (blocks.length === 0) {
          return { content: [{ type: "text", text: String(sel?.message ?? "No content extracted.") }] };
        }
        const source = args?.selector ? `selector "${args.selector}"` : `nodeId ${args?.nodeId}`;
        // One docs_blocks row per matched element, not one call joining all
        // of them together — keeps each block individually addressable/
        // searchable via browser_query_docs instead of every match from a
        // broad selector landing in one big blob.
        const blockIds: number[] = [];
        let sessionTotalChars = 0;
        for (let i = 0; i < blocks.length; i++) {
          const label = blocks.length > 1 ? `${source} (match ${i + 1}/${blocks.length})` : source;
          const added = dataStore.addDocsBlock(SESSION_ID, blocks[i], label);
          blockIds.push(added.blockId);
          sessionTotalChars = added.sessionTotalChars;
        }
        const preview = blocks[0].slice(0, PREVIEW_CHARS);
        return {
          content: [{
            type: "text",
            text: `Extracted ${blocks.length} of ${sel?.count} matched element(s) from ${source}. Saved as docs block${blockIds.length > 1 ? 's' : ''} [${blockIds.join(', ')}] — this session now has ${sessionTotalChars} docs chars total. Content is NOT included in this response; use browser_query_docs({action:"read", blockId:${blockIds[0]}}) to retrieve one, or {action:"search", query:"..."} to search across blocks.${sel?.truncated ? ' [truncated at maxChars/maxMatches this call — narrow the selector or raise the caps for more]' : ''}\n\nPreview of first block:\n${preview}${blocks[0].length > PREVIEW_CHARS ? '…' : ''}`,
          }],
        };
      }
      case "browser_batch_crawl": {
        const crawl = await executeCommand("batch_crawl", {
          urls: args?.urls,
          concurrency: args?.concurrency,
          maxCharsPerUrl: args?.maxCharsPerUrl,
        }, 60000);
        if (crawl?.error) {
          return {
            content: [{ type: "text", text: `Error: ${crawl.error}${crawl.hint ? ` (${crawl.hint})` : ''}` }],
            isError: true,
          };
        }
        const items = (crawl?.items as Array<{
          url: string;
          status: string;
          fetchDurationMs?: number;
          title?: string;
          byline?: string;
          publishedTime?: string;
          readingTime?: string;
          description?: string;
          markdown?: string;
          length?: number;
          error?: string;
        }> | undefined) ?? [];

        const successfulItems = items.filter((i) => i.status === "success" && i.markdown);
        const formattedBlocks = successfulItems.map((item) => {
          const metaLines = [
            `# [${item.title || item.url}](${item.url})`,
            `> 🌐 **Source URL**: \`${item.url}\``,
            `> ⏱️ **Crawled At**: \`${new Date().toISOString()}\` | **Latency**: \`${item.fetchDurationMs ?? 0}ms\` | **Reading Time**: \`${item.readingTime || 'N/A'}\``,
            ...(item.byline ? [`> 👤 **Author**: ${item.byline}`] : []),
            ...(item.publishedTime ? [`> 📅 **Published**: ${item.publishedTime}`] : []),
            ...(item.description ? [`> 💬 **Summary**: ${item.description}`] : []),
            "",
            item.markdown,
          ];
          return metaLines.join("\n");
        });

        let fileReport = "";
        if (formattedBlocks.length > 0) {
          // One row per crawled URL (not one call joining all of them) —
          // same reasoning as browser_select_content above.
          const blockIds: number[] = [];
          let sessionTotalChars = 0;
          for (let i = 0; i < formattedBlocks.length; i++) {
            const item = successfulItems[i];
            const added = dataStore.addDocsBlock(SESSION_ID, formattedBlocks[i], item.url, item.title || item.url);
            blockIds.push(added.blockId);
            sessionTotalChars = added.sessionTotalChars;
          }
          fileReport = `\nSaved ${blockIds.length} docs block(s) [${blockIds.join(', ')}] — this session now has ${sessionTotalChars} docs chars total. Query via browser_query_docs.`;
        }

        const summaryLines = [
          `⚡ Batch crawled ${crawl?.totalProcessed ?? items.length} URL(s) in ${crawl?.durationMs}ms: ${crawl?.successful} succeeded, ${crawl?.failed} failed${crawl?.duplicatesSkipped ? ` (${crawl.duplicatesSkipped} duplicates skipped)` : ''}.${fileReport}`,
          `📊 Throughput: ${crawl?.throughputPagesPerSec ?? 0} pages/s | Avg Latency: ${crawl?.avgFetchLatencyMs ?? 0}ms/page | Discovered Outlinks: ${(crawl?.discoveredOutlinks as string[])?.length ?? 0}`,
          "",
          "### Crawl Results Summary:",
          ...items.map((item, idx) => {
            if (item.status === "success") {
              return `${idx + 1}. ✅ [${item.title || item.url}](${item.url}) — ${item.fetchDurationMs ? `${item.fetchDurationMs}ms | ` : ''}${item.readingTime || `${item.length} chars`}`;
            } else if (item.status === "skipped_duplicate") {
              return `${idx + 1}. ⏭️ ${item.url} (skipped duplicate)`;
            } else {
              return `${idx + 1}. ❌ ${item.url} — ${item.error || "Failed"}`;
            }
          }),
        ];

        return {
          content: [{
            type: "text",
            text: summaryLines.join("\n"),
          }],
        };
      }
      case "browser_search":
        result = await executeCommand("web_search", { query: args?.query, limit: args?.limit });
        break;
      case "browser_deep_crawl": {
        const started = startDeepCrawl({
          seedUrls: args?.seedUrls as string[] | undefined,
          searchQuery: args?.searchQuery as string | undefined,
          depth: args?.depth as number | undefined,
          maxPages: args?.maxPages as number | undefined,
          maxOutlinksPerPage: args?.maxOutlinksPerPage as number | undefined,
          concurrency: args?.concurrency as number | undefined,
          maxCharsPerUrl: args?.maxCharsPerUrl as number | undefined,
        }, executeCommand, SESSION_ID);
        if ("error" in started) {
          return {
            content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: `Started deep crawl ${started.crawlId} (depth ${started.depth}, up to ${started.maxPages} pages, ${started.concurrency} concurrent workers) running in the background. Poll browser_task_status({taskId: "${started.crawlId}"}) for progress — don't wait here.`,
          }],
        };
      }
      case "browser_start_job": {
        const rawTasks = (args?.tasks as JobTaskInput[] | undefined) ?? [];
        const started = startJob(rawTasks, Number(args?.concurrency) || undefined, executeCommand, SESSION_ID);
        if ("error" in started) {
          return {
            content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: `Started job ${started.jobId} with ${started.total} task(s) running in the background. Poll browser_task_status({taskId: "${started.jobId}"}) for progress — don't wait here, this call is meant to return immediately.`,
          }],
        };
      }
      case "browser_task_status": {
        const taskId = String(args?.taskId ?? "");
        result = jobExists(taskId)
          ? getJobStatusText(taskId)
          : crawlExists(taskId)
            ? getDeepCrawlStatusText(taskId)
            : `No task with id "${taskId}" — it may have already completed and been cleaned up (a task is dropped once you've seen its last result), or the id is wrong.`;
        break;
      }
      case "browser_query_docs": {
        const action = String(args?.action ?? "");
        const scopeSessionId = args?.allSessions ? undefined : SESSION_ID;
        if (action === "list") {
          const blocks = dataStore.listDocsBlocks({ sessionId: scopeSessionId, limit: Number(args?.limit) || undefined });
          result = { blocks };
        } else if (action === "search") {
          const query = typeof args?.query === "string" ? args.query : "";
          if (!query) {
            return { content: [{ type: "text", text: `Error: Missing query (hint: action:"search" needs a \`query\` string.)` }], isError: true };
          }
          const blocks = dataStore.searchDocsBlocks(query, { sessionId: scopeSessionId, limit: Number(args?.limit) || undefined });
          result = { blocks };
        } else if (action === "read") {
          const blockId = Number(args?.blockId);
          if (!Number.isFinite(blockId)) {
            return { content: [{ type: "text", text: `Error: Missing blockId (hint: action:"read" needs a \`blockId\` from a prior 'list' or 'search' result.)` }], isError: true };
          }
          const block = dataStore.getDocsBlock(blockId);
          if (!block) {
            return { content: [{ type: "text", text: `Error: No docs block with id ${blockId} (hint: it may belong to a different session — retry with allSessions:true, or it never existed.)` }], isError: true };
          }
          result = { ...block };
        } else {
          return { content: [{ type: "text", text: `Error: Unknown action "${action}" (hint: use "list", "search", or "read".)` }], isError: true };
        }
        break;
      }
      case "browser_set_session_name":
        dataStore.setSessionName(SESSION_ID, String(args?.name ?? ""));
        result = { success: true, message: `Session ${SESSION_ID} renamed to "${args?.name}".` };
        break;
      case "browser_close_tab":
        result = await executeCommand("close_tab", { tabId: args?.tabId });
        break;
      case "browser_screenshot": {
        const shot = await executeCommand("screenshot", {
          fullPage: args?.fullPage,
          format: args?.format,
          quality: args?.quality,
          tabId: args?.tabId,
        });
        if (!shot?.dataBase64) {
          return {
            content: [{ type: "text", text: `Error: ${shot?.error ?? 'Screenshot failed'}${shot?.hint ? ` (${shot.hint})` : ''}` }],
            isError: true,
          };
        }
        const shotFilePath = saveScreenshotToFile(shot.dataBase64 as string, shot.format as string);
        return {
          content: [
            ...(INLINE_IMAGES ? [{ type: "image" as const, data: shot.dataBase64 as string, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg' }] : []),
            { type: "text", text: `Captured ${shot.format} screenshot (${args?.fullPage ? 'full page' : 'viewport'}). Saved to ${shotFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to view; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${shot._flowWarning ? `\n\n[${shot._flowWarning}]` : ''}` },
          ],
        };
      }
      case "browser_start_recording": {
        const ack = await executeCommand("start_capture");
        if (!ack?.success) {
          return {
            content: [{ type: "text", text: `Error: ${ack?.error ?? 'Failed to start recording'}${ack?.hint ? ` (${ack.hint})` : ''}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `${ack.message} Call browser_stop_recording when done.` }] };
      }
      case "browser_stop_recording": {
        // Longer timeout than the 15s default: this has to flush the
        // MediaRecorder and base64-encode a multi-MB blob before it can
        // respond, not just round-trip a CDP call.
        const rec = await executeCommand("stop_capture", {}, 60000);
        if (!rec?.dataBase64) {
          return {
            content: [{ type: "text", text: `Error: ${rec?.error ?? 'Failed to stop recording'}${rec?.hint ? ` (${rec.hint})` : ''}` }],
            isError: true,
          };
        }
        const recFilePath = saveVideoToFile(rec.dataBase64 as string, rec.format as string);
        const seconds = ((rec.durationMs as number) / 1000).toFixed(1);
        const frameNote = rec.frameCount === 0 ? " Warning: 0 frames captured — the page may not have repainted during the recording, or the screencast never started; check the daemon log." : ` (${rec.frameCount} frames)`;
        return {
          content: [{ type: "text", text: `Saved ${seconds}s ${rec.format} recording to ${recFilePath}${frameNote}. To see what actions were taken during the recording, check data/logs/session-*.jsonl for entries in that time window.${rec._flowWarning ? `\n\n[${rec._flowWarning}]` : ''}` }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true
    };
  }
}

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const start = Date.now();
  dataStore.recordToolCall(SESSION_ID);
  const response = await handleToolCall(request);
  logToolCall(request.params.name, request.params.arguments, response, Date.now() - start);
  return response;
});

async function runMcp() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("🚀 MCP Server is connected to stdio");
}

runMcp().catch(e => console.error("MCP Server failed", e));

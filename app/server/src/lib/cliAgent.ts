import { spawn } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// EXPERIMENTAL — sidepanel Chat tab's backend. Spawns `claude`/`agy`/a
// custom command per turn (rides the user's CLI subscription, not an API
// key). `claude` gets extra flags for streaming, --resume, and read-only
// browser_inspect access (chatMcpServer in daemon.ts); other CLIs are a
// best-effort single-shot text pipe.
// TODO: per-turn `claude` cold start + a ToolSearch round trip put a
// floor of several seconds on every turn — fixable only by keeping one
// long-lived process across turns, not a flag. Revisit once this
// graduates past "experiment", or drop it.

export interface AgentQueryParams {
    prompt: string;
    url?: string;
    title?: string;
    selectionText?: string;
    compactContext?: string;
    customCommand?: string;
    timeoutMs?: number;
    /** Resume the given `claude` session instead of starting a fresh one (multi-turn continuity + prompt caching). */
    sessionId?: string;
}

export interface AgentQueryResult {
    success: boolean;
    content: string;
    commandUsed: string;
    durationMs: number;
    error?: string;
    sessionId?: string;
}

const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
const AGENT_SANDBOX_DIR = join(DATA_DIR, "sandbox", "agent");
const MCP_CONFIG_PATH = join(AGENT_SANDBOX_DIR, "mcp-config.json");

// daemon.ts imports this module unconditionally, so setup is deferred to
// first use (not import time) — otherwise every boot touches disk for a
// feature that may never be opened.
let sandboxReady = false;
function ensureSandboxSetup() {
    if (sandboxReady) return;
    sandboxReady = true;
    try {
        if (!existsSync(AGENT_SANDBOX_DIR)) mkdirSync(AGENT_SANDBOX_DIR, { recursive: true });
        // --mcp-config target: this daemon's own read-only MCP endpoint
        // (chatMcpServer in daemon.ts), so the agent can inspect the real
        // page instead of only the text snapshot pasted into the prompt.
        writeFileSync(MCP_CONFIG_PATH, JSON.stringify({
            mcpServers: { browsercontrol: { type: "http", url: "http://127.0.0.1:8765/mcp" } },
        }));
    } catch {}
}

const CHAT_SYSTEM_PROMPT =
    "You are chatting inside the BrowserControl Chrome extension's side panel, answering questions " +
    "about the user's currently active browser tab. The page URL/title/selection/text pasted below " +
    "is a quick snapshot that may be stale or incomplete. You have a READ-ONLY MCP tool " +
    "mcp__browsercontrol__browser_inspect (actions: snapshot, find, reading_mode, inspect_element, " +
    "screenshot, select_content, network_requests, peek_screen) that reads the REAL live page, " +
    "including a visual screenshot via peek_screen({screenshot:true}) or the screenshot action — call " +
    "it whenever the pasted snapshot isn't enough instead of guessing. You cannot click, type, " +
    "navigate, or otherwise act on the page from this chat.";

let activeAgentProc: ReturnType<typeof spawn> | null = null;
let activeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

// Resolved via PATH (Bun.which) rather than a hardcoded per-machine
// install path — that would leak a local username into git and break for
// anyone installed elsewhere. Not on PATH? The user types a full path
// into the Settings tab's command field (customCommand) instead.
function resolveBinary(baseName: string): string | null {
    const candidates = process.platform === "win32" ? [`${baseName}.exe`, baseName] : [baseName];
    for (const name of candidates) {
        const found = Bun.which(name);
        if (found) return found;
    }
    return null;
}

export function detectAvailableAgents(): { hasAgy: boolean; hasClaude: boolean; agyPath?: string; claudePath?: string } {
    const agy = resolveBinary("agy");
    const claude = resolveBinary("claude");
    return {
        hasAgy: agy !== null,
        hasClaude: claude !== null,
        agyPath: agy ?? undefined,
        claudePath: claude ?? undefined,
    };
}

/** Kills the whole process tree, not just `pid` — see spawnAgentProc's `detached: true`. */
function killProcessTree(pid: number) {
    if (process.platform === "win32") {
        try {
            Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
        } catch {}
    } else {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {}
    }
}

export function abortActiveAgentQuery(): boolean {
    if (activeTimeoutTimer) {
        clearTimeout(activeTimeoutTimer);
        activeTimeoutTimer = null;
    }
    if (activeAgentProc) {
        const pid = activeAgentProc.pid;
        try {
            activeAgentProc.kill();
        } catch {}
        killProcessTree(pid);
        activeAgentProc = null;
        return true;
    }
    return false;
}

export function isAgentBusy(): boolean {
    return activeAgentProc !== null;
}

/**
 * Split command line into array of tokens safely without breaking quotes.
 */
function parseCommandTokens(cmd: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if ((ch === '"' || ch === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = ch;
        } else if (ch === quoteChar && inQuotes) {
            inQuotes = false;
            quoteChar = "";
        } else if (ch === " " && !inQuotes) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
        } else {
            current += ch;
        }
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

function buildFusedPrompt(params: AgentQueryParams): string {
    let fullPrompt = params.prompt.trim();
    const contextParts: string[] = [];
    if (params.url) contextParts.push(`Page URL: ${params.url}`);
    if (params.title) contextParts.push(`Page Title: ${params.title}`);
    if (params.selectionText) contextParts.push(`User Selected Text:\n"${params.selectionText}"`);
    if (params.compactContext) contextParts.push(`Page Summary Context:\n${params.compactContext}`);

    if (contextParts.length > 0) {
        fullPrompt = `[BROWSER ACTIVE PAGE CONTEXT]\n${contextParts.join("\n")}\n\n[USER INSTRUCTION / REQUEST]\n${fullPrompt}`;
    }
    return fullPrompt;
}

/**
 * Resolves the base binary+args to run (from customCommand or the claude/agy
 * fallback) and whether it's `claude`, which gets extra flags appended by
 * the caller (streaming format, mcp-config, session resume).
 */
function resolveBaseTokens(params: AgentQueryParams): { baseTokens: string[]; isClaude: boolean } | null {
    const custom = (params.customCommand || "").trim();
    const agents = detectAvailableAgents();

    if (custom) {
        const tokens = parseCommandTokens(custom);
        const binName = tokens[0]?.toLowerCase();
        const isClaude = binName === "claude" || binName === "claude.exe";
        if (isClaude && agents.claudePath) tokens[0] = agents.claudePath;
        if ((binName === "agy" || binName === "agy.exe") && agents.agyPath) tokens[0] = agents.agyPath;
        return { baseTokens: tokens, isClaude };
    }

    if (agents.hasClaude && agents.claudePath) {
        return { baseTokens: [agents.claudePath, "--print"], isClaude: true };
    }
    if (agents.hasAgy && agents.agyPath) {
        return { baseTokens: [agents.agyPath, "--print"], isClaude: false };
    }
    return null;
}

/** Appends the flags that make a `claude --print` invocation stream, session-resume, and reach browser_inspect. */
function withClaudeSmartFlags(baseTokens: string[], params: AgentQueryParams, outputFormat: "stream-json" | "json"): string[] {
    const flags = [
        `--output-format=${outputFormat}`,
        "--verbose",
        `--mcp-config=${MCP_CONFIG_PATH}`,
        "--strict-mcp-config",
        "--allowedTools=mcp__browsercontrol__browser_inspect",
        `--append-system-prompt=${CHAT_SYSTEM_PROMPT}`,
    ];
    if (outputFormat === "stream-json") flags.push("--include-partial-messages");
    if (params.sessionId) flags.push(`--resume=${params.sessionId}`);
    return [...baseTokens, ...flags];
}

function spawnAgentProc(spawnTokens: string[]) {
    ensureSandboxSetup();
    const proc = spawn(spawnTokens, {
        cwd: AGENT_SANDBOX_DIR,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true, // own process group/job — see killProcessTree()
    });
    activeAgentProc = proc;
    return proc;
}

/**
 * Executes a one-shot prompt against the CLI Agent (used by the Settings
 * tab's test-run button). Uses `--output-format json` on claude for a
 * single parseable envelope instead of the NDJSON stream.
 */
export async function executeCliAgentQuery(params: AgentQueryParams): Promise<AgentQueryResult> {
    const start = Date.now();
    const timeoutMs = params.timeoutMs ?? 90_000;
    abortActiveAgentQuery();

    const resolved = resolveBaseTokens(params);
    if (!resolved) {
        return {
            success: false,
            content: "No CLI Agent (agy or claude) found on system PATH.",
            commandUsed: "none",
            durationMs: Date.now() - start,
            error: "CLI Agent not found",
        };
    }

    const fullPrompt = buildFusedPrompt(params);
    const spawnTokens = resolved.isClaude
        ? [...withClaudeSmartFlags(resolved.baseTokens, params, "json"), fullPrompt]
        : [...resolved.baseTokens, fullPrompt];
    const commandUsed = spawnTokens.slice(0, -1).join(" ");

    try {
        const proc = spawnAgentProc(spawnTokens);

        const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
            activeTimeoutTimer = setTimeout(() => {
                abortActiveAgentQuery();
                resolve({ timedOut: true });
            }, timeoutMs);
        });

        const readStdout = (proc.stdout && typeof proc.stdout !== "number")
            ? new Response(proc.stdout).text()
            : Promise.resolve("");
        const readStderr = (proc.stderr && typeof proc.stderr !== "number")
            ? new Response(proc.stderr).text()
            : Promise.resolve("");

        await Promise.race([proc.exited, timeoutPromise]);

        if (activeTimeoutTimer) {
            clearTimeout(activeTimeoutTimer);
            activeTimeoutTimer = null;
        }
        activeAgentProc = null;

        const stdoutRaw = (await readStdout).trim();
        const stderrRaw = (await readStderr).trim();

        if (resolved.isClaude && stdoutRaw) {
            try {
                // --output-format json prints an array of every message envelope
                // for the turn (init/assistant/tool calls/...) — the final one is the result.
                const arr = JSON.parse(stdoutRaw) as Array<{ type?: string; result?: string; session_id?: string; is_error?: boolean }>;
                const parsed = Array.isArray(arr) ? arr[arr.length - 1] ?? {} : (arr as unknown as { result?: string; session_id?: string; is_error?: boolean });
                return {
                    success: true,
                    content: parsed.result ?? "(no result)",
                    commandUsed,
                    durationMs: Date.now() - start,
                    sessionId: parsed.session_id,
                    error: parsed.is_error ? parsed.result : undefined,
                };
            } catch {
                // Fall through to raw-text handling below (e.g. claude exited before emitting JSON).
            }
        }

        let responseContent = stdoutRaw;
        if (!responseContent && stderrRaw) responseContent = `CLI Error Output: ${stderrRaw}`;
        if (!responseContent) responseContent = "Command executed successfully (no stdout produced).";

        return { success: true, content: responseContent, commandUsed, durationMs: Date.now() - start };
    } catch (e) {
        activeAgentProc = null;
        const errMsg = e instanceof Error ? e.message : String(e);
        return {
            success: false,
            content: `Failed to execute CLI agent command: ${errMsg}`,
            commandUsed,
            durationMs: Date.now() - start,
            error: errMsg,
        };
    }
}

type ClaudeStreamEvent = { type: string; content_block?: { type: string; id?: string; name?: string } };
type ClaudeStreamLine =
    | { type: "system"; subtype?: string; session_id?: string }
    | { type: "stream_event"; event: ClaudeStreamEvent }
    | { type: "user"; message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } }
    | { type: "result"; subtype?: string; is_error?: boolean; result?: string; session_id?: string }
    | { type: string; [k: string]: unknown };

/**
 * Streams a claude `--output-format stream-json` NDJSON stdout as SSE
 * events: real per-token text (not just OS pipe buffering), tool_use/
 * tool_result so the panel can show what browser_inspect call is running,
 * and the session id to persist for the next turn's --resume.
 */
function pumpClaudeStream(proc: ReturnType<typeof spawn>, controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    const send = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    const toolNameById = new Map<string, string>();
    let buffer = "";

    return (async () => {
        if (!proc.stdout || typeof proc.stdout === "number") return;
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                let parsed: ClaudeStreamLine;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }
                if (parsed.type === "system" && (parsed as { session_id?: string }).session_id) {
                    send({ type: "session", sessionId: (parsed as { session_id?: string }).session_id });
                } else if (parsed.type === "stream_event") {
                    const event = (parsed as { event: ClaudeStreamEvent }).event;
                    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                        const name = event.content_block.name ?? "tool";
                        if (event.content_block.id) toolNameById.set(event.content_block.id, name);
                        send({ type: "tool_use", name });
                    } else if (event.type === "content_block_delta") {
                        const delta = (event as unknown as { delta?: { type: string; text?: string } }).delta;
                        if (delta?.type === "text_delta" && delta.text) send({ type: "chunk", text: delta.text });
                    }
                } else if (parsed.type === "user") {
                    const blocks = (parsed as { message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } }).message?.content ?? [];
                    for (const b of blocks) {
                        if (b.type === "tool_result") {
                            send({ type: "tool_result", name: (b.tool_use_id && toolNameById.get(b.tool_use_id)) || "tool", isError: !!b.is_error });
                        }
                    }
                } else if (parsed.type === "result") {
                    const r = parsed as { subtype?: string; is_error?: boolean; result?: string; session_id?: string };
                    if (r.is_error) send({ type: "error", error: r.result || `CLI exited: ${r.subtype}` });
                    send({ type: "session", sessionId: r.session_id });
                }
            }
        }
    })();
}

export function streamCliAgentQuery(params: AgentQueryParams): ReadableStream {
    abortActiveAgentQuery();
    const timeoutMs = params.timeoutMs ?? 90_000;
    const start = Date.now();

    const resolved = resolveBaseTokens(params);
    if (!resolved) {
        return new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", error: "CLI Agent not found" })}\n\n`));
                controller.close();
            },
        });
    }

    const fullPrompt = buildFusedPrompt(params);
    const spawnTokens = resolved.isClaude
        ? [...withClaudeSmartFlags(resolved.baseTokens, params, "stream-json"), fullPrompt]
        : [...resolved.baseTokens, fullPrompt];
    const commandUsed = spawnTokens.slice(0, -1).join(" ");
    const isClaude = resolved.isClaude;

    return new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            try {
                const proc = spawnAgentProc(spawnTokens);
                activeTimeoutTimer = setTimeout(() => abortActiveAgentQuery(), timeoutMs);

                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", commandUsed })}\n\n`));

                if (isClaude) {
                    await pumpClaudeStream(proc, controller, encoder);
                } else if (proc.stdout && typeof proc.stdout !== "number") {
                    // Non-claude CLIs: no stream-json contract, just forward raw stdout chunks.
                    const reader = proc.stdout.getReader();
                    const decoder = new TextDecoder();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const textChunk = decoder.decode(value, { stream: true });
                        if (textChunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chunk", text: textChunk })}\n\n`));
                    }
                }

                await proc.exited;
                if (activeTimeoutTimer) {
                    clearTimeout(activeTimeoutTimer);
                    activeTimeoutTimer = null;
                }
                activeAgentProc = null;

                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", durationMs: Date.now() - start })}\n\n`));
                controller.close();
            } catch (e) {
                activeAgentProc = null;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: String(e) })}\n\n`));
                controller.close();
            }
        },
        cancel() {
            abortActiveAgentQuery();
        },
    });
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "bun";
import { loadAuthToken } from "../../configs/auth.js";
import { AGENT_SANDBOX_DIR, MCP_CONFIG_PATH } from "../../configs/paths.js";
import { HOSTNAME, PORT } from "../../configs/server.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { CHAT_SYSTEM_PROMPT, DEFAULT_TIMEOUT_MS } from "./constants.js";
import type { AgentId, AgentQueryParams, AgentQueryResult, ClaudeStreamEvent, ClaudeStreamLine } from "./types.js";

export type { AgentQueryParams, AgentQueryResult } from "./types.js";

/**
 * EXPERIMENTAL — sidepanel Chat tab's backend. Spawns the allowlisted
 * `claude`/`agy` agent per turn (rides the user's CLI subscription, not an API
 * key). `claude` gets extra flags for streaming, --resume, and read-only
 * browser_inspect access (chatMcpServer in daemon.ts); other CLIs are a
 * best-effort single-shot text pipe.
 *
 * TODO: per-turn `claude` cold start + a ToolSearch round trip put a floor
 * of several seconds on every turn — fixable only by keeping one
 * long-lived process across turns, not a flag. Revisit once this
 * graduates past "experiment", or drop it.
 */

// daemon.ts imports this module unconditionally, so setup is deferred to first use, not import time.
let sandboxReady = false;
function ensureSandboxSetup() {
  if (sandboxReady) return;
  sandboxReady = true;
  try {
    if (!existsSync(AGENT_SANDBOX_DIR)) mkdirSync(AGENT_SANDBOX_DIR, { recursive: true });
    // Points at this daemon's own read-only MCP endpoint (daemon.ts's /mcp) so the agent can inspect the real page.
    writeFileSync(
      MCP_CONFIG_PATH,
      JSON.stringify({
        mcpServers: {
          browsercontrol: {
            type: "http",
            url: `http://${HOSTNAME}:${PORT}/mcp`,
            headers: { Authorization: `Bearer ${loadAuthToken()}` },
          },
        },
      }),
    );
  } catch {}
}

let activeAgentProc: ReturnType<typeof spawn> | null = null;
let activeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Resolved via PATH (Bun.which) rather than a hardcoded per-machine install
 * path — that would leak a local username into git and break for anyone
 * installed elsewhere. The settings field accepts only the allowlisted agent
 * name and documented flags; the server resolves the executable from PATH.
 */
function resolveBinary(baseName: string): string | null {
  const candidates = process.platform === "win32" ? [`${baseName}.exe`, baseName] : [baseName];
  for (const name of candidates) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

function resolveAvailableAgents(): { agyPath: string | null; claudePath: string | null } {
  return { agyPath: resolveBinary("agy"), claudePath: resolveBinary("claude") };
}

/** Reports which allowlisted CLI agents are available without exposing local paths. */
export function detectAvailableAgents(): { hasAgy: boolean; hasClaude: boolean } {
  const { agyPath, claudePath } = resolveAvailableAgents();
  return { hasAgy: agyPath !== null, hasClaude: claudePath !== null };
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

/** Kills the active agent process, if any. Returns whether one was actually running. */
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

const ALLOWED_CLAUDE_FLAGS = new Set(["--print", "-p"]);
const ALLOWED_AGY_FLAGS = new Set(["--print", "-p", "--effort"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high"]);
const MAX_OUTPUT_CHARS = 1_000_000;

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

export function validateAgentCommand(command: string): { agent: "claude" | "agy"; tokens: string[] } {
  return validateAgentTokens(parseCommandTokens(command));
}

function validateAgentTokens(tokens: string[]): { agent: "claude" | "agy"; tokens: string[] } {
  const executable = tokens[0]?.toLowerCase();
  const agent =
    executable === "claude" || executable === "claude.exe"
      ? "claude"
      : executable === "agy" || executable === "agy.exe"
        ? "agy"
        : null;
  if (!agent || tokens[0]?.includes("/") || tokens[0]?.includes("\\")) {
    throw new Error("CLI agent must be the allowlisted `claude` or `agy` binary; arbitrary paths are not permitted");
  }

  const allowedFlags = agent === "claude" ? ALLOWED_CLAUDE_FLAGS : ALLOWED_AGY_FLAGS;
  for (let index = 1; index < tokens.length; index++) {
    const flag = tokens[index];
    if (!flag || !allowedFlags.has(flag)) throw new Error(`Unsupported ${agent} CLI flag: ${flag ?? ""}`);
    if (flag === "--effort") {
      const effort = tokens[++index];
      if (!effort || !ALLOWED_EFFORTS.has(effort)) throw new Error("--effort must be low, medium, or high");
    }
  }
  return { agent, tokens };
}

function displayCommand(tokens: string[]): string {
  return tokens
    .map((token, index) => {
      if (index === 0 && /[\\/]/.test(token)) return token.toLowerCase().includes("agy") ? "agy" : "claude";
      if (token.startsWith("--mcp-config=")) return "--mcp-config=<local>";
      if (token.startsWith("--append-system-prompt=")) return "--append-system-prompt=<local>";
      return token;
    })
    .join(" ");
}

async function readLimited(stream: ReadableStream<Uint8Array>, maxChars: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (output.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  if (output.length >= maxChars) {
    await reader.cancel();
    output = `${output.slice(0, maxChars)}\n[output truncated]`;
  }
  return output;
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
 * Resolves the base binary+args to run from the allowlisted agent selection,
 * and whether it's `claude`, which gets extra flags appended by
 * the caller (streaming format, mcp-config, session resume).
 */
function resolveBaseTokens(params: AgentQueryParams): { baseTokens: string[]; isClaude: boolean } | null {
  const agents = resolveAvailableAgents();
  const requested: AgentId | undefined = params.agentId;
  if (params.effort && !ALLOWED_EFFORTS.has(params.effort)) {
    throw new Error("--effort must be low, medium, or high");
  }
  const selected =
    requested === "agy"
      ? agents.agyPath
      : requested === "claude"
        ? agents.claudePath
        : (agents.claudePath ?? agents.agyPath);
  if (!selected) return null;

  const isClaude = requested === "agy" ? false : requested === "claude" ? true : agents.claudePath !== null;
  const baseTokens = [selected];
  if (isClaude || !params.effort) baseTokens.push("--print");
  else baseTokens.push("--effort", params.effort, "-p");
  return { baseTokens, isClaude };
}

/** Appends the flags that make a `claude --print` invocation stream, session-resume, and reach browser_inspect. */
function withClaudeSmartFlags(
  baseTokens: string[],
  params: AgentQueryParams,
  outputFormat: "stream-json" | "json",
): string[] {
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
  const env: Record<string, string> = { NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const proc = spawn(spawnTokens, {
    cwd: AGENT_SANDBOX_DIR,
    env,
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
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  const commandUsed = displayCommand(spawnTokens.slice(0, -1));

  try {
    const proc = spawnAgentProc(spawnTokens);

    const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
      activeTimeoutTimer = setTimeout(() => {
        abortActiveAgentQuery();
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    const readStdout =
      proc.stdout && typeof proc.stdout !== "number" ? readLimited(proc.stdout, MAX_OUTPUT_CHARS) : Promise.resolve("");
    const readStderr =
      proc.stderr && typeof proc.stderr !== "number" ? readLimited(proc.stderr, MAX_OUTPUT_CHARS) : Promise.resolve("");

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
        // --output-format json prints an array of every message envelope for the turn — the final one is the result.
        const arr = JSON.parse(stdoutRaw) as Array<{
          type?: string;
          result?: string;
          session_id?: string;
          is_error?: boolean;
        }>;
        const parsed = Array.isArray(arr)
          ? (arr[arr.length - 1] ?? {})
          : (arr as unknown as { result?: string; session_id?: string; is_error?: boolean });
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
    const errMsg = errorMessage(e);
    return {
      success: false,
      content: `Failed to execute CLI agent command: ${errMsg}`,
      commandUsed,
      durationMs: Date.now() - start,
      error: errMsg,
    };
  }
}

/**
 * Streams a claude `--output-format stream-json` NDJSON stdout as SSE
 * events: real per-token text (not just OS pipe buffering), tool_use/
 * tool_result so the panel can show what browser_inspect call is running,
 * and the session id to persist for the next turn's --resume.
 */
function pumpClaudeStream(
  proc: ReturnType<typeof spawn>,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
) {
  const send = (payload: Record<string, unknown>) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  let outputChars = 0;
  const sendText = (text: string) => {
    const remaining = MAX_OUTPUT_CHARS - outputChars;
    if (remaining <= 0) return;
    const chunk = text.slice(0, remaining);
    outputChars += chunk.length;
    if (chunk) send({ type: "chunk", text: chunk });
  };
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
        switch (parsed.type) {
          case "system": {
            const sid = (parsed as { session_id?: string }).session_id;
            if (sid) send({ type: "session", sessionId: sid });
            break;
          }
          case "stream_event": {
            const event = (parsed as { event: ClaudeStreamEvent }).event;
            switch (event.type) {
              case "content_block_start":
                if (event.content_block?.type === "tool_use") {
                  const name = event.content_block.name ?? "tool";
                  if (event.content_block.id) toolNameById.set(event.content_block.id, name);
                  send({ type: "tool_use", name });
                }
                break;
              case "content_block_delta": {
                const delta = (event as unknown as { delta?: { type: string; text?: string } }).delta;
                if (delta?.type === "text_delta" && delta.text) sendText(delta.text);
                break;
              }
            }
            break;
          }
          case "user": {
            const blocks =
              (parsed as { message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } })
                .message?.content ?? [];
            for (const b of blocks) {
              if (b.type === "tool_result") {
                send({
                  type: "tool_result",
                  name: (b.tool_use_id && toolNameById.get(b.tool_use_id)) || "tool",
                  isError: !!b.is_error,
                });
              }
            }
            break;
          }
          case "result": {
            const r = parsed as { subtype?: string; is_error?: boolean; result?: string; session_id?: string };
            if (r.is_error) send({ type: "error", error: r.result || `CLI exited: ${r.subtype}` });
            send({ type: "session", sessionId: r.session_id });
            break;
          }
        }
      }
    }
  })();
}

/** SSE stream of a `claude --output-format stream-json` (or raw-text, for non-claude CLIs) turn. */
export function streamCliAgentQuery(params: AgentQueryParams): ReadableStream {
  abortActiveAgentQuery();
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const resolved = resolveBaseTokens(params);
  if (!resolved) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", error: "CLI Agent not found" })}\n\n`),
        );
        controller.close();
      },
    });
  }

  const fullPrompt = buildFusedPrompt(params);
  const spawnTokens = resolved.isClaude
    ? [...withClaudeSmartFlags(resolved.baseTokens, params, "stream-json"), fullPrompt]
    : [...resolved.baseTokens, fullPrompt];
  const commandUsed = displayCommand(spawnTokens.slice(0, -1));
  const isClaude = resolved.isClaude;

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const proc = spawnAgentProc(spawnTokens);
        const stderrDrain =
          proc.stderr && typeof proc.stderr !== "number"
            ? readLimited(proc.stderr, MAX_OUTPUT_CHARS)
            : Promise.resolve("");
        activeTimeoutTimer = setTimeout(() => abortActiveAgentQuery(), timeoutMs);

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start", commandUsed })}\n\n`));

        if (isClaude) {
          await pumpClaudeStream(proc, controller, encoder);
        } else if (proc.stdout && typeof proc.stdout !== "number") {
          // Non-claude CLIs: no stream-json contract, just forward raw stdout chunks.
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let outputChars = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const textChunk = decoder.decode(value, { stream: true });
            const remaining = MAX_OUTPUT_CHARS - outputChars;
            if (remaining <= 0) continue;
            const boundedChunk = textChunk.slice(0, remaining);
            outputChars += boundedChunk.length;
            if (boundedChunk)
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chunk", text: boundedChunk })}\n\n`));
          }
        }

        await Promise.all([proc.exited, stderrDrain]);
        if (activeTimeoutTimer) {
          clearTimeout(activeTimeoutTimer);
          activeTimeoutTimer = null;
        }
        activeAgentProc = null;

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "done", durationMs: Date.now() - start })}\n\n`),
        );
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

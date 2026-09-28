import type { BenchmarkMetrics } from "@browsercontrol/benchmark";
import type { FlowStep, FlowStepV2 } from "@browsercontrol/shared";
import { getSettingsSync } from "../../../configs/settings.js";

export type { BenchmarkMetrics, FlowStep, FlowStepV2 };

const DAEMON_PORT = 8765;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

export interface FlowMeta {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  stepCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlowFull extends FlowMeta {
  schemaVersion?: 1 | 2;
  steps: FlowStepV2[];
}

export interface FlowRunResult {
  success: boolean;
  stoppedAtStep?: number;
  reason?: string;
  message?: string;
  error?: string;
  hint?: string;
}

export class DaemonUnreachableError extends Error {}

type AgentId = "claude" | "agy";
type AgentEffort = "low" | "medium" | "high";

type AgentSelection = { agentId?: AgentId; effort?: AgentEffort };

function agentSelectionFromLegacyCommand(command?: string): AgentSelection {
  const trimmed = command?.trim();
  if (!trimmed) return {};
  const [executable, ...flags] = trimmed.split(/\s+/);
  const normalized = executable?.toLowerCase();
  const agentId =
    normalized === "claude" || normalized === "claude.exe"
      ? "claude"
      : normalized === "agy" || normalized === "agy.exe"
        ? "agy"
        : null;
  if (!agentId) throw new Error("CLI agent must be `claude` or `agy`");

  let effort: AgentEffort | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--print" || flag === "-p") continue;
    if (flag === "--effort") {
      const value = flags[++index];
      if (value !== "low" && value !== "medium" && value !== "high") {
        throw new Error("--effort must be low, medium, or high");
      }
      effort = value;
      continue;
    }
    throw new Error(`Unsupported ${agentId} CLI flag: ${flag ?? ""}`);
  }
  return { agentId, ...(effort ? { effort } : {}) };
}

async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    const headers = new Headers(init?.headers);
    const token = getSettingsSync().daemonAuthToken.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return await fetch(`${DAEMON_URL}${path}`, { ...init, headers });
  } catch {
    throw new DaemonUnreachableError(
      "Can't reach the BrowserControl daemon at 127.0.0.1:8765 — is it running (spawned by your MCP client) with the extension connected?",
    );
  }
}

export async function listFlows(): Promise<FlowMeta[]> {
  const res = await daemonFetch("/flows");
  if (!res.ok) throw new Error(`Failed to list flows (HTTP ${res.status})`);
  const data = (await res.json()) as { flows: FlowMeta[] };
  return data.flows;
}

export async function getFlow(id: string): Promise<FlowFull> {
  const res = await daemonFetch(`/flows/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to get flow (HTTP ${res.status})`);
  const data = (await res.json()) as { flow: FlowFull };
  return data.flow;
}

export async function saveFlow(input: {
  id?: string;
  name: string;
  description?: string;
  domain?: string;
  steps: readonly (FlowStep | FlowStepV2)[];
}): Promise<FlowFull> {
  const res = await daemonFetch("/flows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to save flow (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { flow: FlowFull };
  return data.flow;
}

export async function executeDirect(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const response = await new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        chrome.runtime.sendMessage({ target: "background", payload: { cmd, ...args } }, (res) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(res);
        });
      });
      if (response?.error) throw new Error(response.error);
      return response?.result;
    } catch {
      // Fall through to daemonFetch fallback
    }
  }

  const res = await daemonFetch("/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd, ...args }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Direct command failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { success?: boolean; result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result ?? data;
}

export async function startFlowRecording(domain?: string): Promise<{ success: boolean; message: string }> {
  return (await executeDirect("start_flow_recording", { domain })) as { success: boolean; message: string };
}

export async function stopFlowRecording(): Promise<{
  steps: FlowStep[];
  domain: string;
  stepCount: number;
  durationMs: number;
}> {
  return (await executeDirect("stop_flow_recording")) as {
    steps: FlowStep[];
    domain: string;
    stepCount: number;
    durationMs: number;
  };
}

export async function getFlowRecordingStatus(): Promise<{
  isRecording: boolean;
  stepCount: number;
  steps: FlowStep[];
}> {
  return (await executeDirect("flow_recording_status")) as {
    isRecording: boolean;
    stepCount: number;
    steps: FlowStep[];
  };
}

export interface DaemonStatus {
  extensionConnected: boolean;
  version: string;
}

export async function getStatus(): Promise<DaemonStatus> {
  const res = await daemonFetch("/status");
  if (!res.ok) throw new Error(`Failed to get status (HTTP ${res.status})`);
  return (await res.json()) as DaemonStatus;
}

export async function deleteFlow(id: string): Promise<void> {
  const res = await daemonFetch(`/flows/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to delete flow (HTTP ${res.status})`);
  }
}

export async function runFlow(id: string): Promise<FlowRunResult> {
  try {
    const flow = await getFlow(id);
    if (flow?.steps && flow.steps.length > 0) {
      const res = (await executeDirect("run_flow", {
        steps: flow.steps,
        domain: flow.domain,
      })) as FlowRunResult;
      if (res && typeof res.success === "boolean") {
        return res;
      }
    }
  } catch {
    // Fallback to daemon endpoint
  }

  const res = await daemonFetch(`/flows/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.success !== "boolean") {
    throw new Error(typeof data.error === "string" ? data.error : `Run failed (HTTP ${res.status})`);
  }
  return data as unknown as FlowRunResult;
}

export async function getMetrics(sessionId?: string): Promise<BenchmarkMetrics> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const res = await daemonFetch(`/metrics${query}`);
  if (!res.ok) throw new Error(`Failed to get metrics (HTTP ${res.status})`);
  return (await res.json()) as BenchmarkMetrics;
}

export interface CliAgentQueryResult {
  success: boolean;
  content: string;
  commandUsed: string;
  durationMs: number;
  error?: string;
  sessionId?: string;
}

export interface CliAgentStatusResult {
  hasAgy: boolean;
  hasClaude: boolean;
  isBusy: boolean;
}

export async function getCliAgentStatus(): Promise<CliAgentStatusResult> {
  const res = await daemonFetch("/cli-agent/status");
  if (!res.ok) throw new Error(`Failed to get CLI agent status (HTTP ${res.status})`);
  return (await res.json()) as CliAgentStatusResult;
}

export async function queryCliAgent(data: {
  prompt: string;
  url?: string;
  title?: string;
  selectionText?: string;
  compactContext?: string;
  customCommand?: string;
  sessionId?: string;
}): Promise<CliAgentQueryResult> {
  const { customCommand, ...request } = data;
  const res = await daemonFetch("/cli-agent/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, ...agentSelectionFromLegacyCommand(customCommand) }),
  });
  if (!res.ok) throw new Error(`Failed to query CLI agent (HTTP ${res.status})`);
  return (await res.json()) as CliAgentQueryResult;
}

export async function abortCliAgent(): Promise<void> {
  await daemonFetch("/cli-agent/abort", { method: "POST" });
}

export async function streamCliAgent(
  data: {
    prompt: string;
    url?: string;
    title?: string;
    selectionText?: string;
    compactContext?: string;
    customCommand?: string;
    sessionId?: string;
  },
  callbacks: {
    onStart?: (commandUsed: string) => void;
    onChunk?: (chunk: string) => void;
    onToolUse?: (name: string) => void;
    onToolResult?: (name: string, isError: boolean) => void;
    onSession?: (sessionId: string) => void;
    onDone?: (durationMs: number) => void;
    onError?: (error: string) => void;
  },
): Promise<void> {
  const { customCommand, ...request } = data;
  const res = await daemonFetch("/cli-agent/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, ...agentSelectionFromLegacyCommand(customCommand) }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Failed to initiate stream (HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() ?? "";

    for (const block of lines) {
      const line = block.trim();
      if (!line.startsWith("data: ")) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        switch (payload.type) {
          case "start":
            callbacks.onStart?.(payload.commandUsed);
            break;
          case "chunk":
            callbacks.onChunk?.(payload.text);
            break;
          case "tool_use":
            callbacks.onToolUse?.(payload.name);
            break;
          case "tool_result":
            callbacks.onToolResult?.(payload.name, Boolean(payload.isError));
            break;
          case "session":
            if (payload.sessionId) callbacks.onSession?.(payload.sessionId);
            break;
          case "done":
            callbacks.onDone?.(payload.durationMs);
            break;
          case "error":
            callbacks.onError?.(payload.error);
            break;
        }
      } catch {}
    }
  }
}

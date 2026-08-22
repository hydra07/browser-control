import type { BenchmarkMetrics } from "@browsercontrol/benchmark";
import type { FlowStep } from "@browsercontrol/shared";

export type { BenchmarkMetrics, FlowStep };

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
  steps: FlowStep[];
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

async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${DAEMON_URL}${path}`, init);
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
  steps: FlowStep[];
}): Promise<FlowMeta> {
  const res = await daemonFetch("/flows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to save flow (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { flow: FlowMeta };
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
  agyPath?: string;
  claudePath?: string;
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
  const res = await daemonFetch("/cli-agent/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
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
  const res = await daemonFetch("/cli-agent/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
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

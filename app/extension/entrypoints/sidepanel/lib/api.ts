// HTTP client for the daemon's REST endpoints (src/daemon.ts).
// Used by the side panel React UI to list/run saved flows and check status.

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

export interface FlowStep {
  action: "click" | "type" | "press_key" | "wait_for" | "assert_text" | "scroll" | "drag";
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  key?: string;
  contains?: string;
  deltaX?: number;
  deltaY?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  timeoutMs?: number;
  confirmRisky?: boolean;
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
  const res = await daemonFetch(`/flows/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.success !== "boolean") {
    throw new Error(
      typeof data.error === "string" ? data.error : `Run failed (HTTP ${res.status})`,
    );
  }
  return data as unknown as FlowRunResult;
}

export interface BenchmarkMetrics {
  summary: {
    sessionId: string;
    sessionName: string;
    startedAt: number;
    totalCalls: number;
    totalInTokens: number;
    totalOutTokens: number;
    totalTokens: number;
    totalInChars: number;
    totalOutChars: number;
    avgInTokensPerCall: number;
    avgOutTokensPerCall: number;
    avgTokensPerCall: number;
    avgDurationMs: number;
    totalDurationMs: number;
    errorCount: number;
    errorRatePct: number;
    flowStepTotal: number;
  };
  tokenSavings: {
    estimatedSavedTokens: number;
    savingsBreakdown: {
      fromFlowBatching: number;
      fromCompactSnapshots: number;
      fromDocsBlocks: number;
    };
  };
  byCommand: Array<{
    cmd: string;
    count: number;
    inTokens: number;
    outTokens: number;
    totalTokens: number;
    avgTokens: number;
    totalDurationMs: number;
    avgDurationMs: number;
    errorCount: number;
    pctOfTokens: number;
  }>;
  recentCalls: Array<{
    id: number;
    cmd: string;
    durationMs: number;
    inTokens: number;
    outTokens: number;
    approxTokens: number;
    isError: boolean;
    source: string;
    preview: string;
    elementRole?: string;
    elementName?: string;
    stepCount?: number;
    createdAt: number;
    argsSummary: string;
  }>;
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
        if (payload.type === "start" && callbacks.onStart) {
          callbacks.onStart(payload.commandUsed);
        } else if (payload.type === "chunk" && callbacks.onChunk) {
          callbacks.onChunk(payload.text);
        } else if (payload.type === "tool_use" && callbacks.onToolUse) {
          callbacks.onToolUse(payload.name);
        } else if (payload.type === "tool_result" && callbacks.onToolResult) {
          callbacks.onToolResult(payload.name, Boolean(payload.isError));
        } else if (payload.type === "session" && payload.sessionId && callbacks.onSession) {
          callbacks.onSession(payload.sessionId);
        } else if (payload.type === "done" && callbacks.onDone) {
          callbacks.onDone(payload.durationMs);
        } else if (payload.type === "error" && callbacks.onError) {
          callbacks.onError(payload.error);
        }
      } catch {}
    }
  }
}

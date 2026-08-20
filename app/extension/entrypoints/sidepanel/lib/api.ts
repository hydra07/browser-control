// Talks to the daemon's existing Bun.serve HTTP server directly (fetch to
// 127.0.0.1:8765) — the side panel is a browser page, not an MCP client, so
// it has no stdio channel to the daemon the way an MCP client does. Same
// pattern replay.ts already uses for /execute; see daemon.ts's GET /flows
// and POST /flows/:id/run for the server side of this.
const DAEMON_URL = "http://127.0.0.1:8765";

export interface FlowMeta {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
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

// Mirrors flow.ts's FlowReport shape (app/extension/lib/flow.ts) — only the
// fields the panel actually renders.
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
  } catch (e) {
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

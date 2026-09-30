import type { FlowStep, FlowStepV2 } from "@browsercontrol/shared";
import { getSettingsSync } from "../../../configs/settings.js";

export type { FlowStep, FlowStepV2 };

/** The Go CLI bridge (`browsercontrol serve`, auto-started by any CLI command). */
const BRIDGE_URL = "http://127.0.0.1:8765";

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

export class BridgeUnreachableError extends Error {}

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    const headers = new Headers(init?.headers);
    const token = getSettingsSync().daemonAuthToken.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return await fetch(`${BRIDGE_URL}${path}`, { ...init, headers });
  } catch {
    throw new BridgeUnreachableError(
      "Can't reach the BrowserControl bridge at 127.0.0.1:8765 — run any `browsercontrol` command (e.g. `browsercontrol status`) to start it.",
    );
  }
}

export async function listFlows(): Promise<FlowMeta[]> {
  const res = await bridgeFetch("/flows");
  if (!res.ok) throw new Error(`Failed to list flows (HTTP ${res.status})`);
  const data = (await res.json()) as { flows: FlowMeta[] };
  return data.flows;
}

export async function getFlow(id: string): Promise<FlowFull> {
  const res = await bridgeFetch(`/flows/${encodeURIComponent(id)}`);
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
  const res = await bridgeFetch("/flows", {
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
      // Fall through to bridgeFetch fallback
    }
  }

  const res = await bridgeFetch("/execute", {
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

export interface BridgeStatus {
  extensionConnected: boolean;
  version: string;
}

export async function getStatus(): Promise<BridgeStatus> {
  const res = await bridgeFetch("/status");
  if (!res.ok) throw new Error(`Failed to get status (HTTP ${res.status})`);
  return (await res.json()) as BridgeStatus;
}

export async function deleteFlow(id: string): Promise<void> {
  const res = await bridgeFetch(`/flows/${encodeURIComponent(id)}`, {
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
    // Fall back to the bridge endpoint
  }

  const res = await bridgeFetch(`/flows/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.success !== "boolean") {
    throw new Error(typeof data.error === "string" ? data.error : `Run failed (HTTP ${res.status})`);
  }
  return data as unknown as FlowRunResult;
}

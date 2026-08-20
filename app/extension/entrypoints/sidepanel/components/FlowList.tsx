import { useState } from "react";
import { runFlow, type FlowMeta, type FlowRunResult } from "../lib/api";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: FlowRunResult }
  | { status: "error"; message: string };

function formatRelativeTime(ms: number): string {
  const diffS = Math.max(0, (Date.now() - ms) / 1000);
  if (diffS < 60) return "just now";
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

function RunStatus({ state }: { state: RunState }) {
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return <div className="mt-1.5 text-[11.5px] text-brand-violet">Running…</div>;
  }
  if (state.status === "error") {
    return <div className="mt-1.5 text-[11.5px] text-red-300">{state.message}</div>;
  }
  const r = state.result;
  if (r.success) {
    return <div className="mt-1.5 text-[11.5px] text-emerald-300">✓ {r.message ?? "Done"}</div>;
  }
  return (
    <div className="mt-1.5 text-[11.5px] text-red-300">
      ✗ {r.message ?? r.reason ?? r.error ?? "Failed"}
    </div>
  );
}

function FlowItem({ flow }: { flow: FlowMeta }) {
  const [state, setState] = useState<RunState>({ status: "idle" });

  async function handleRun() {
    setState({ status: "running" });
    try {
      const result = await runFlow(flow.id);
      setState({ status: "done", result });
    } catch (e) {
      setState({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/5 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{flow.name}</span>
          {flow.domain && (
            <span className="flex-none rounded-full bg-brand-cyan/10 px-2 py-0.5 text-[10.5px] text-cyan-300">
              {flow.domain}
            </span>
          )}
        </div>
        {flow.description && (
          <div className="mt-0.5 text-xs text-gray-400">{flow.description}</div>
        )}
        <div className="mt-1 text-[11px] text-gray-500">
          {flow.stepCount} step{flow.stepCount === 1 ? "" : "s"} · updated{" "}
          {formatRelativeTime(flow.updatedAt)}
        </div>
        <RunStatus state={state} />
      </div>
      <button
        type="button"
        onClick={handleRun}
        disabled={state.status === "running"}
        title="Run this flow against the current tab"
        className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-gradient-to-br from-brand-violet to-brand-indigo text-xs text-white hover:brightness-110 disabled:pointer-events-none disabled:opacity-50"
      >
        {state.status === "running" ? "…" : "▶"}
      </button>
    </li>
  );
}

export function FlowList({ flows }: { flows: FlowMeta[] }) {
  if (flows.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-gray-400">
        No flows saved yet. Ask your agent to save one with
        browser_save_flow once you've validated a browser_run_flow
        sequence — it'll show up here with a Run button.
      </div>
    );
  }
  return (
    <ul className="flex-1 space-y-1.5 overflow-y-auto p-2">
      {flows.map((f) => (
        <FlowItem key={f.id} flow={f} />
      ))}
    </ul>
  );
}

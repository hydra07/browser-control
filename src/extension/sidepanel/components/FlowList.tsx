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
        return <div className="run-status run-status-running">Running…</div>;
    }
    if (state.status === "error") {
        return <div className="run-status run-status-fail">{state.message}</div>;
    }
    const r = state.result;
    if (r.success) {
        return <div className="run-status run-status-ok">✓ {r.message ?? "Done"}</div>;
    }
    return (
        <div className="run-status run-status-fail">
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
        <li className="flow-item">
            <div className="flow-item-main">
                <div className="flow-item-header">
                    <span className="flow-name">{flow.name}</span>
                    {flow.domain && <span className="flow-badge">{flow.domain}</span>}
                </div>
                {flow.description && (
                    <div className="flow-desc">{flow.description}</div>
                )}
                <div className="flow-meta">
                    {flow.stepCount} step{flow.stepCount === 1 ? "" : "s"} · updated{" "}
                    {formatRelativeTime(flow.updatedAt)}
                </div>
                <RunStatus state={state} />
            </div>
            <button
                className="run-button"
                onClick={handleRun}
                disabled={state.status === "running"}
                title="Run this flow against the current tab"
            >
                {state.status === "running" ? "…" : "▶"}
            </button>
        </li>
    );
}

export function FlowList({ flows }: { flows: FlowMeta[] }) {
    if (flows.length === 0) {
        return (
            <div className="empty-state">
                No flows saved yet. Ask your agent to save one with
                browser_save_flow once you've validated a browser_run_flow
                sequence — it'll show up here with a Run button.
            </div>
        );
    }
    return (
        <ul className="flow-list">
            {flows.map((f) => (
                <FlowItem key={f.id} flow={f} />
            ))}
        </ul>
    );
}

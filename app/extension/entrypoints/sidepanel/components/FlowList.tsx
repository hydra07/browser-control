import React, { useState, useMemo, useEffect } from "react";
import {
  deleteFlow,
  runFlow,
  getFlow,
  type FlowMeta,
  type FlowFull,
  type FlowStep,
  type FlowRunResult,
} from "../lib/api";
import {
  PlayIcon,
  TrashIcon,
  CheckIcon,
  CrossIcon,
  SearchIcon,
  ChevronDownIcon,
  CopyIcon,
  MousePointerIcon,
  KeyboardIcon,
  KeyReturnIcon,
  HourglassIcon,
  ShieldCheckIcon,
  ScrollIcon,
  MoveIcon,
  WorkflowIcon,
} from "./Icons";

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

function StepActionBadge({ action }: { action: FlowStep["action"] }) {
  switch (action) {
    case "click":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-blue-400 border border-blue-500/20">
          <MousePointerIcon className="w-2.5 h-2.5" />
          <span>CLICK</span>
        </span>
      );
    case "type":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-amber-400 border border-amber-500/20">
          <KeyboardIcon className="w-2.5 h-2.5" />
          <span>TYPE</span>
        </span>
      );
    case "press_key":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-purple-400 border border-purple-500/20">
          <KeyReturnIcon className="w-2.5 h-2.5" />
          <span>KEY</span>
        </span>
      );
    case "wait_for":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-cyan-400 border border-cyan-500/20">
          <HourglassIcon className="w-2.5 h-2.5" />
          <span>WAIT</span>
        </span>
      );
    case "assert_text":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-emerald-400 border border-emerald-500/20">
          <ShieldCheckIcon className="w-2.5 h-2.5" />
          <span>ASSERT</span>
        </span>
      );
    case "scroll":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-zinc-400 border border-zinc-500/20">
          <ScrollIcon className="w-2.5 h-2.5" />
          <span>SCROLL</span>
        </span>
      );
    case "drag":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-orange-400 border border-orange-500/20">
          <MoveIcon className="w-2.5 h-2.5" />
          <span>DRAG</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
          {action}
        </span>
      );
  }
}

function StepDetails({ step, index }: { step: FlowStep; index: number }) {
  return (
    <div className="group relative flex items-start gap-2.5 rounded-md bg-[#121318] p-2 border border-zinc-800/80 hover:border-zinc-700 transition">
      <span className="flex-none font-mono text-[10px] text-zinc-500 w-4 text-right pt-0.5">
        #{index + 1}
      </span>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <StepActionBadge action={step.action} />
          {step.role && (
            <span className="font-mono text-[10px] text-zinc-400 bg-zinc-800/60 px-1 py-0.2 rounded">
              role: {step.role}
            </span>
          )}
          {step.name && (
            <span className="font-mono text-[10px] text-zinc-300 bg-zinc-800/60 px-1 py-0.2 rounded">
              name: "{step.name}"
            </span>
          )}
          {step.selector && (
            <span className="font-mono text-[10px] text-indigo-300 bg-indigo-950/40 px-1 py-0.2 rounded border border-indigo-900/40 truncate max-w-[200px]" title={step.selector}>
              {step.selector}
            </span>
          )}
        </div>

        {/* Step parameters */}
        <div className="text-[10.5px] font-mono text-zinc-400 pl-0.5 space-y-0.5">
          {step.text && (
            <div className="text-amber-300/90 truncate">
              text: <span className="text-zinc-200">"{step.text}"</span>
            </div>
          )}
          {step.key && (
            <div className="text-purple-300/90">
              key: <span className="text-zinc-200">{step.key}</span>
            </div>
          )}
          {step.contains && (
            <div className="text-emerald-300/90 truncate">
              contains: <span className="text-zinc-200">"{step.contains}"</span>
            </div>
          )}
          {(step.deltaX !== undefined || step.deltaY !== undefined) && (
            <div className="text-zinc-400">
              delta: ({step.deltaX ?? 0}, {step.deltaY ?? 0})px
            </div>
          )}
          {(step.fromX !== undefined || step.toX !== undefined) && (
            <div className="text-orange-300/90">
              drag: ({step.fromX}, {step.fromY}) -&gt; ({step.toX}, {step.toY})
            </div>
          )}
          {step.timeoutMs && (
            <div className="text-zinc-500 text-[10px]">
              timeout: {step.timeoutMs}ms
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunReport({ state }: { state: RunState }) {
  if (state.status === "idle") return null;

  if (state.status === "running") {
    return (
      <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-indigo-950/30 border border-indigo-800/40 px-2.5 py-1.5 font-mono text-[11px] text-indigo-300">
        <div className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
        <span>Executing flow steps on current tab…</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-rose-950/30 border border-rose-800/40 p-2.5 font-mono text-[11px] text-rose-300">
        <CrossIcon className="w-3.5 h-3.5 flex-none mt-0.5 text-rose-400" />
        <span className="break-all">{state.message}</span>
      </div>
    );
  }

  const r = state.result;
  if (r.success) {
    return (
      <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-emerald-950/30 border border-emerald-800/40 px-2.5 py-1.5 font-mono text-[11px] text-emerald-300">
        <CheckIcon className="w-3.5 h-3.5 flex-none text-emerald-400" />
        <span>{r.message ?? "Flow executed successfully"}</span>
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-rose-950/30 border border-rose-800/40 p-2.5 font-mono text-[11px] text-rose-300">
      <CrossIcon className="w-3.5 h-3.5 flex-none mt-0.5 text-rose-400" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-rose-200">Execution failed</div>
        <div className="mt-0.5 opacity-90">{r.message ?? r.reason ?? r.error ?? "Failed at step"}</div>
      </div>
    </div>
  );
}

function FlowCard({
  flow,
  onDeleted,
}: {
  flow: FlowMeta;
  onDeleted: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullFlow, setFullFlow] = useState<FlowFull | null>(null);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [state, setState] = useState<RunState>({ status: "idle" });
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (expanded && !fullFlow) {
      setLoadingSteps(true);
      getFlow(flow.id)
        .then((f) => setFullFlow(f))
        .catch(() => {})
        .finally(() => setLoadingSteps(false));
    }
  }, [expanded, flow.id, fullFlow]);

  async function handleRun(e: React.MouseEvent) {
    e.stopPropagation();
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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      await deleteFlow(flow.id);
      onDeleted(flow.id);
    } catch (e) {
      setDeleting(false);
      setState({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function handleCopySteps(e: React.MouseEvent) {
    e.stopPropagation();
    if (!fullFlow) return;
    void navigator.clipboard.writeText(JSON.stringify(fullFlow.steps, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isRunning = state.status === "running";

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-[#16171d] transition hover:border-zinc-700/80 shadow-sm overflow-hidden">
      {/* Main Flow Header & Controls */}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded(!expanded)}>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-zinc-100 text-[12.5px] truncate hover:text-white transition">
                {flow.name}
              </h3>
              {flow.domain && (
                <span className="font-mono text-[10px] text-zinc-400 bg-zinc-800/80 px-1.5 py-0.2 rounded border border-zinc-700/40">
                  {flow.domain}
                </span>
              )}
            </div>

            {flow.description && (
              <p className="mt-1 text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                {flow.description}
              </p>
            )}

            <div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-zinc-500 font-mono">
              <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-zinc-300">
                {flow.stepCount} {flow.stepCount === 1 ? "step" : "steps"}
              </span>
              <span>•</span>
              <span>{formatRelativeTime(flow.updatedAt)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-none items-center gap-1.5">
            <button
              type="button"
              onClick={handleRun}
              disabled={isRunning || deleting}
              title="Run this flow on current tab"
              className="flex h-7 items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 text-[11px] font-semibold text-zinc-950 hover:bg-white active:scale-95 disabled:opacity-40 transition shadow-sm"
            >
              {isRunning ? (
                <div className="h-2.5 w-2.5 rounded-full border-2 border-zinc-950 border-t-transparent animate-spin" />
              ) : (
                <PlayIcon className="w-2.5 h-2.5" />
              )}
              <span>Run</span>
            </button>

            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? "Collapse behaviors" : "Inspect flow behaviors"}
              className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${
                expanded
                  ? "bg-zinc-800 text-zinc-200 border-zinc-700"
                  : "bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
            </button>

            <button
              type="button"
              onClick={handleDelete}
              disabled={isRunning || deleting}
              title={confirmDelete ? "Click again to confirm delete" : "Delete flow"}
              className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${
                confirmDelete
                  ? "bg-rose-950/60 text-rose-300 border-rose-800 ring-1 ring-rose-700/50"
                  : "bg-zinc-900/40 border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <RunReport state={state} />
      </div>

      {/* Expanded Behavior / Steps Inspector Drawer */}
      {expanded && (
        <div className="border-t border-zinc-800/80 bg-[#0f1015] p-3 space-y-2 animate-in fade-in duration-200">
          <div className="flex items-center justify-between pb-1">
            <div className="flex items-center gap-1.5 text-[11px] font-mono font-medium text-zinc-300">
              <span>BEHAVIOR SEQUENCE</span>
              <span className="text-[10px] text-zinc-500">({fullFlow?.steps.length ?? flow.stepCount} steps)</span>
            </div>

            {fullFlow && (
              <button
                type="button"
                onClick={handleCopySteps}
                className="flex items-center gap-1 rounded bg-zinc-800/70 px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:bg-zinc-700 hover:text-white transition"
              >
                <CopyIcon className="w-2.5 h-2.5" />
                <span>{copied ? "Copied" : "Copy JSON"}</span>
              </button>
            )}
          </div>

          {loadingSteps && (
            <div className="py-4 text-center font-mono text-[10.5px] text-zinc-500">
              Loading steps...
            </div>
          )}

          {fullFlow && (
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
              {fullFlow.steps.map((step, idx) => (
                <StepDetails key={idx} step={step} index={idx} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FlowList({
  flows,
  onFlowDeleted,
}: {
  flows: FlowMeta[];
  onFlowDeleted: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);

  const domains = useMemo(() => {
    const set = new Set<string>();
    for (const f of flows) {
      if (f.domain) set.add(f.domain);
    }
    return Array.from(set);
  }, [flows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flows.filter((f) => {
      const matchesText =
        !q ||
        f.name.toLowerCase().includes(q) ||
        (f.description && f.description.toLowerCase().includes(q)) ||
        (f.domain && f.domain.toLowerCase().includes(q));

      const matchesDomain = !selectedDomain || f.domain === selectedDomain;
      return matchesText && matchesDomain;
    });
  }, [flows, query, selectedDomain]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Filter and Search Bar */}
      <div className="flex-none p-2.5 space-y-2 border-b border-zinc-800/80 bg-[#111217]">
        <div className="relative flex items-center">
          <SearchIcon className="absolute left-2.5 h-3.5 w-3.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Search flows by name, domain, behavior..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg bg-zinc-900 border border-zinc-800/80 py-1.5 pl-8 pr-6 text-[11.5px] text-zinc-200 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none transition"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 text-zinc-500 hover:text-zinc-300"
            >
              <CrossIcon className="w-2.5 h-2.5" />
            </button>
          )}
        </div>

        {domains.length > 1 && (
          <div className="flex gap-1 overflow-x-auto pb-0.5 text-[10.5px]">
            <button
              type="button"
              onClick={() => setSelectedDomain(null)}
              className={`rounded-md px-2 py-0.5 font-mono transition ${
                selectedDomain === null
                  ? "bg-zinc-200 text-zinc-950 font-semibold"
                  : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              ALL ({flows.length})
            </button>
            {domains.map((dom) => (
              <button
                key={dom}
                type="button"
                onClick={() => setSelectedDomain(selectedDomain === dom ? null : dom)}
                className={`rounded-md px-2 py-0.5 font-mono whitespace-nowrap transition ${
                  selectedDomain === dom
                    ? "bg-zinc-200 text-zinc-950 font-semibold"
                    : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {dom}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* List Content */}
      <div className="flex-1 space-y-2.5 overflow-y-auto p-2.5">
        {filtered.map((flow) => (
          <FlowCard key={flow.id} flow={flow} onDeleted={onFlowDeleted} />
        ))}

        {flows.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center text-zinc-500">
            <WorkflowIcon className="w-8 h-8 text-zinc-600 mb-2" />
            <div className="font-mono text-[11.5px] text-zinc-400">No flows recorded</div>
            <div className="mt-1 text-[10.5px] text-zinc-600 max-w-[200px]">
              Use <span className="font-mono text-zinc-300">browser_save_flow</span> to persist reusable step sequences.
            </div>
          </div>
        )}

        {flows.length > 0 && filtered.length === 0 && (
          <div className="py-10 text-center text-zinc-500 text-[11px] font-mono">
            No flows match "{query}"
          </div>
        )}
      </div>
    </div>
  );
}

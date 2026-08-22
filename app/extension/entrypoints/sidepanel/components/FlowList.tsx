import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  deleteFlow,
  type FlowFull,
  type FlowMeta,
  type FlowRunResult,
  type FlowStep,
  getFlow,
  getFlowRecordingStatus,
  runFlow,
  saveFlow,
  startFlowRecording,
  stopFlowRecording,
} from "../lib/api";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CrossIcon,
  HourglassIcon,
  KeyboardIcon,
  KeyReturnIcon,
  MousePointerIcon,
  MoveIcon,
  PlayIcon,
  ScrollIcon,
  SearchIcon,
  ShieldCheckIcon,
  TrashIcon,
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
      return null;
  }
}

function StepRow({ step, index }: { step: FlowStep; index: number }) {
  return (
    <div className="flex items-start gap-2 py-1 px-1.5 text-[11px] font-mono hover:bg-zinc-800/40 rounded transition">
      <span className="w-4 flex-none text-[10px] text-zinc-500 text-right select-none">{index + 1}.</span>
      <div className="flex-none pt-0.5">
        <StepActionBadge action={step.action} />
      </div>
      <div className="flex-1 min-w-0 break-words text-zinc-300">
        {step.action === "click" && (
          <span>
            {step.role && <span className="text-zinc-500">{step.role} </span>}
            {step.name && <span className="text-zinc-200">"{step.name}" </span>}
            {step.selector && <span className="text-zinc-500 text-[10px]">({step.selector})</span>}
          </span>
        )}
        {step.action === "type" && (
          <span>
            <span className="text-amber-300/90 font-sans font-medium">"{step.text}"</span>
            {(step.role || step.name) && (
              <span className="text-zinc-500">
                {" "}
                into {step.role} "{step.name}"
              </span>
            )}
            {step.selector && <span className="text-zinc-500 text-[10px]"> ({step.selector})</span>}
          </span>
        )}
        {step.action === "press_key" && (
          <span>
            <span className="text-purple-300 font-semibold">{step.key}</span>
            {step.selector && <span className="text-zinc-500 text-[10px]"> on {step.selector}</span>}
          </span>
        )}
        {step.action === "wait_for" && (
          <span>
            {step.role && <span className="text-zinc-500">{step.role} </span>}
            {step.name && <span className="text-zinc-200">"{step.name}" </span>}
            {step.selector && <span className="text-zinc-500 text-[10px]">({step.selector}) </span>}
            {step.timeoutMs && <span className="text-zinc-500 text-[10px]">timeout: {step.timeoutMs}ms</span>}
          </span>
        )}
        {step.action === "assert_text" && (
          <span>
            contains <span className="text-emerald-300">"{step.contains}"</span>
            {step.selector && <span className="text-zinc-500 text-[10px]"> in {step.selector}</span>}
          </span>
        )}
        {step.action === "scroll" && (
          <span className="text-zinc-400">
            dx: {step.deltaX ?? 0}, dy: {step.deltaY ?? 0}
          </span>
        )}
        {step.action === "drag" && (
          <span className="text-zinc-400">
            ({step.fromX},{step.fromY}) → ({step.toX},{step.toY})
          </span>
        )}
      </div>
    </div>
  );
}

function FlowCard({ flow, onDeleted }: { flow: FlowMeta; onDeleted: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [fullFlow, setFullFlow] = useState<FlowFull | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (expanded && !fullFlow && !loadingFull) {
      setLoadingFull(true);
      getFlow(flow.id)
        .then((f) => setFullFlow(f))
        .catch((e) => console.error("Failed to load flow details", e))
        .finally(() => setLoadingFull(false));
    }
  }, [expanded, fullFlow, loadingFull, flow.id]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function handleRun(e: MouseEvent) {
    e.stopPropagation();
    if (runState.status === "running") return;
    setRunState({ status: "running" });
    try {
      const res = await runFlow(flow.id);
      setRunState({ status: "done", result: res });
    } catch (err: unknown) {
      setRunState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteFlow(flow.id);
      onDeleted(flow.id);
    } catch (err) {
      console.error("Failed to delete flow:", err);
    }
  }

  function handleCopyJson(e: MouseEvent) {
    e.stopPropagation();
    if (!fullFlow) return;
    navigator.clipboard.writeText(JSON.stringify(fullFlow.steps, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={`group rounded-lg border bg-[#14151a] transition ${
        expanded ? "border-zinc-700/80 shadow-lg" : "border-zinc-800/80 hover:border-zinc-700/60"
      }`}
    >
      <div className="flex items-center gap-3 p-3 cursor-pointer select-none" onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[12.5px] text-zinc-100 truncate">{flow.name}</span>
            {flow.domain && (
              <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 border border-zinc-700/40">
                {flow.domain}
              </span>
            )}
          </div>
          {flow.description && <p className="mt-0.5 text-[11.5px] text-zinc-400 line-clamp-1">{flow.description}</p>}
          <div className="mt-1 flex items-center gap-3 text-[10.5px] text-zinc-500 font-mono">
            <span>{flow.stepCount} steps</span>
            <span>•</span>
            <span>{formatRelativeTime(flow.updatedAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-none" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            title="Run flow"
            disabled={runState.status === "running"}
            onClick={handleRun}
            className="flex items-center gap-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 px-2 py-1 text-[11px] font-mono font-medium transition disabled:opacity-50"
          >
            <PlayIcon className="w-3 h-3 fill-current" />
            <span>{runState.status === "running" ? "Running..." : "Run"}</span>
          </button>

          <button
            type="button"
            title={confirmDelete ? "Click again to confirm delete" : "Delete flow"}
            onClick={handleDelete}
            className={`rounded-md p-1 transition ${
              confirmDelete
                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition"
          >
            <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800/80 bg-[#0f1013] p-3 rounded-b-lg space-y-3">
          {loadingFull && <div className="text-center py-2 text-[11px] text-zinc-500 font-mono">Loading steps...</div>}

          {fullFlow && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-mono text-zinc-500 uppercase tracking-wider">Step Sequence</span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="flex items-center gap-1 text-[10.5px] font-mono text-zinc-400 hover:text-zinc-200 transition"
                >
                  {copied ? <CheckIcon className="w-3 h-3 text-emerald-400" /> : <CopyIcon className="w-3 h-3" />}
                  <span>{copied ? "Copied" : "Copy JSON"}</span>
                </button>
              </div>

              <div className="rounded-md border border-zinc-800 bg-[#14151a]/60 p-1 divide-y divide-zinc-800/40">
                {fullFlow.steps.map((step, idx) => (
                  <StepRow key={`${idx}-${step.action}`} step={step} index={idx} />
                ))}
              </div>
            </div>
          )}

          {runState.status !== "idle" && (
            <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/80 p-2.5 text-[11px] font-mono">
              {runState.status === "running" && (
                <div className="flex items-center gap-2 text-zinc-400">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Executing flow sequence...</span>
                </div>
              )}
              {runState.status === "done" && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                    <CheckIcon className="w-3.5 h-3.5" />
                    <span>Run completed successfully</span>
                  </div>
                  <div className="text-zinc-400 text-[10.5px]">{runState.result.message}</div>
                </div>
              )}
              {runState.status === "error" && (
                <div className="space-y-1 text-red-400">
                  <div className="font-semibold">Execution stopped</div>
                  <div className="text-[10.5px] text-red-400/80 break-words">{runState.message}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FlowList({ flows, onFlowDeleted }: { flows: FlowMeta[]; onFlowDeleted: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<FlowStep[]>([]);
  const [recordedDomain, setRecordedDomain] = useState<string>("");
  const [flowName, setFlowName] = useState("");
  const [flowDesc, setFlowDesc] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    async function checkStatus() {
      try {
        const stat = await getFlowRecordingStatus();
        setIsRecording(Boolean(stat?.isRecording));
        setStepCount(Number(stat?.stepCount || 0));
      } catch {}
    }
    checkStatus();
    timer = setInterval(checkStatus, isRecording ? 1000 : 3000);
    return () => clearInterval(timer);
  }, [isRecording]);

  async function handleToggleRecording() {
    if (!isRecording) {
      try {
        await startFlowRecording();
        setIsRecording(true);
        setStepCount(0);
      } catch (e) {
        console.error("Failed to start flow recording", e);
      }
    } else {
      try {
        const res = await stopFlowRecording();
        setIsRecording(false);
        setRecordedSteps(res.steps || []);
        setRecordedDomain(res.domain || "");
        setFlowName(`Flow - ${new Date().toLocaleTimeString()}`);
        setShowSaveModal(true);
      } catch (e) {
        console.error("Failed to stop flow recording", e);
      }
    }
  }

  async function handleSaveRecordedFlow() {
    if (!flowName.trim() || recordedSteps.length === 0) return;
    setSaving(true);
    try {
      const saved = await saveFlow({
        name: flowName.trim(),
        description: flowDesc.trim() || undefined,
        domain: recordedDomain || undefined,
        steps: recordedSteps,
      });
      setShowSaveModal(false);
      setRecordedSteps([]);
      // Trigger update by notifying parent or refreshing
      onFlowDeleted(saved.id);
    } catch (e) {
      console.error("Failed to save flow", e);
    } finally {
      setSaving(false);
    }
  }

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
        f.description?.toLowerCase().includes(q) ||
        f.domain?.toLowerCase().includes(q);

      const matchesDomain = !selectedDomain || f.domain === selectedDomain;
      return matchesText && matchesDomain;
    });
  }, [flows, query, selectedDomain]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Auto-Flow Recording Bar */}
      <div className="flex-none p-2.5 border-b border-zinc-800/80 bg-[#16171d] flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isRecording ? (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[11.5px] font-mono text-red-400 font-medium">Recording ({stepCount} steps)</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 font-mono">
              <WorkflowIcon className="w-3.5 h-3.5 text-zinc-500" />
              <span>Auto-Flow Recorder</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleToggleRecording}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium transition ${
            isRecording
              ? "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30"
              : "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
          }`}
        >
          <span>{isRecording ? "⏹ Stop & Save" : "🔴 Record Flow"}</span>
        </button>
      </div>

      {/* Save Flow Modal */}
      {showSaveModal && (
        <div className="p-3 border-b border-zinc-800 bg-[#121318] space-y-2.5">
          <div className="text-[12px] font-semibold text-zinc-200">
            Save Recorded Flow ({recordedSteps.length} steps)
          </div>
          <input
            type="text"
            placeholder="Flow name (e.g. Login to Dashboard)"
            value={flowName}
            onChange={(e) => setFlowName(e.target.value)}
            className="w-full rounded bg-zinc-900 border border-zinc-800 p-1.5 text-[11.5px] text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
          <input
            type="text"
            placeholder="Optional description"
            value={flowDesc}
            onChange={(e) => setFlowDesc(e.target.value)}
            className="w-full rounded bg-zinc-900 border border-zinc-800 p-1.5 text-[11.5px] text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowSaveModal(false)}
              className="px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !flowName.trim()}
              onClick={handleSaveRecordedFlow}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-zinc-950 font-semibold text-[11px] transition disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Flow"}
            </button>
          </div>
        </div>
      )}

      {/* Search & Domain Filter Bar */}
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

      <div className="flex-1 space-y-2.5 overflow-y-auto p-2.5">
        {filtered.map((flow) => (
          <FlowCard key={flow.id} flow={flow} onDeleted={onFlowDeleted} />
        ))}

        {flows.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center text-zinc-500">
            <WorkflowIcon className="w-8 h-8 text-zinc-600 mb-2" />
            <div className="font-mono text-[11.5px] text-zinc-400">No flows recorded</div>
            <div className="mt-1 text-[10.5px] text-zinc-600 max-w-[200px]">
              Click <span className="font-mono text-red-400">🔴 Record Flow</span> above to capture human browser
              actions into an automated flow.
            </div>
          </div>
        )}

        {flows.length > 0 && filtered.length === 0 && (
          <div className="py-10 text-center text-zinc-500 text-[11px] font-mono">No flows match "{query}"</div>
        )}
      </div>
    </div>
  );
}

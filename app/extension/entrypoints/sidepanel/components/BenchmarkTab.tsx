import React, { useState, useEffect, useCallback } from "react";
import { getMetrics, type BenchmarkMetrics } from "../lib/api";
import {
  ChartBarIcon,
  RefreshIcon,
  ZapIcon,
  LayersIcon,
  CpuIcon,
  CheckIcon,
  CrossIcon,
  ChevronDownIcon,
} from "./Icons";

interface BenchmarkTabProps {
  onRefresh?: () => void;
}

export function BenchmarkTab({ onRefresh }: BenchmarkTabProps) {
  const [metrics, setMetrics] = useState<BenchmarkMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expandedCallId, setExpandedCallId] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await getMetrics();
      setMetrics(data);
    } catch (e) {
      console.error("[BenchmarkTab] Error loading metrics:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMetrics();
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchMetrics(), 3000);
    return () => clearInterval(interval);
  }, [fetchMetrics, autoRefresh]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await fetchMetrics();
    onRefresh?.();
    setTimeout(() => setIsRefreshing(false), 300);
  };

  const formatTokens = (tok: number): string => {
    if (tok >= 1_000_000) return `${(tok / 1_000_000).toFixed(1)}M`;
    if (tok >= 1_000) return `${(tok / 1_000).toFixed(1)}k`;
    return String(tok);
  };

  const formatChars = (chars: number): string => {
    if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`;
    if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}k chars`;
    return `${chars} chars`;
  };

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  if (loading && !metrics) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-zinc-500 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 animate-spin rounded-full border border-indigo-400 border-t-transparent" />
          <span>Loading benchmark metrics...</span>
        </div>
      </div>
    );
  }

  const summary = metrics?.summary ?? {
    sessionId: "—",
    sessionName: "Active Session",
    startedAt: Date.now(),
    totalCalls: 0,
    totalInTokens: 0,
    totalOutTokens: 0,
    totalTokens: 0,
    totalInChars: 0,
    totalOutChars: 0,
    avgInTokensPerCall: 0,
    avgOutTokensPerCall: 0,
    avgTokensPerCall: 0,
    avgDurationMs: 0,
    totalDurationMs: 0,
    errorCount: 0,
    errorRatePct: 0,
    flowStepTotal: 0,
  };

  const tokenSavings = metrics?.tokenSavings ?? {
    estimatedSavedTokens: 0,
    savingsBreakdown: { fromFlowBatching: 0, fromCompactSnapshots: 0, fromDocsBlocks: 0 },
  };

  const byCommand = metrics?.byCommand ?? [];
  const recentCalls = metrics?.recentCalls ?? [];

  const totalInPct = summary.totalTokens > 0 ? Math.round((summary.totalInTokens / summary.totalTokens) * 100) : 0;
  const totalOutPct = summary.totalTokens > 0 ? 100 - totalInPct : 0;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-[#0d0e12] p-3 text-zinc-200 font-sans select-text">
      {/* Top Session & Action Bar */}
      <div className="mb-3 flex items-center justify-between border-b border-zinc-800/80 pb-2.5">
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            <span className="font-mono text-[11px] font-semibold text-zinc-100">
              Session #{summary.sessionId.slice(-6)}
            </span>
          </div>
          <span className="text-[10px] text-zinc-500 truncate max-w-[200px]" title={summary.sessionName}>
            {summary.sessionName}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-[10px] font-mono text-zinc-400 select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded bg-zinc-800 border-zinc-700 text-indigo-500 focus:ring-0 focus:ring-offset-0 h-3 w-3"
            />
            <span>Auto (3s)</span>
          </label>

          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            title="Refresh Metrics"
            className="flex h-6 w-6 items-center justify-center rounded border border-zinc-700/50 bg-zinc-800/80 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition active:scale-95"
          >
            <RefreshIcon className={`h-3 w-3 ${isRefreshing ? "animate-spin text-indigo-300" : ""}`} />
          </button>
        </div>
      </div>

      {/* 4 Primary KPI Cards */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {/* Total Tokens (In + Out) */}
        <div className="rounded-lg border border-zinc-800/90 bg-[#121318] p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-medium uppercase tracking-wider">Total Tokens</span>
            <CpuIcon className="h-3.5 w-3.5 text-indigo-400" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold text-zinc-100">
              {formatTokens(summary.totalTokens)}
            </span>
            <span className="text-[10px] font-mono text-zinc-500">
              (~{summary.avgTokensPerCall}/call)
            </span>
          </div>
        </div>

        {/* Tool Calls & Steps */}
        <div className="rounded-lg border border-zinc-800/90 bg-[#121318] p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-medium uppercase tracking-wider">Tool Calls</span>
            <LayersIcon className="h-3.5 w-3.5 text-sky-400" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold text-zinc-100">
              {summary.totalCalls}
            </span>
            {summary.flowStepTotal > 0 && (
              <span className="text-[10px] font-mono text-emerald-400">
                ({summary.flowStepTotal} steps)
              </span>
            )}
          </div>
        </div>

        {/* Avg Latency */}
        <div className="rounded-lg border border-zinc-800/90 bg-[#121318] p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-[10px] font-medium uppercase tracking-wider">Avg Latency</span>
            <ChartBarIcon className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold text-zinc-100">
              {summary.avgDurationMs}
            </span>
            <span className="text-[10px] font-mono text-zinc-500">ms</span>
            {summary.errorCount > 0 && (
              <span className="ml-auto text-[9px] font-mono text-rose-400 bg-rose-950/40 px-1 rounded border border-rose-900/40">
                {summary.errorCount} err
              </span>
            )}
          </div>
        </div>

        {/* Tokens Saved */}
        <div className="rounded-lg border border-emerald-900/30 bg-emerald-950/10 p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-emerald-400">
            <span className="text-[10px] font-medium uppercase tracking-wider">Tokens Saved</span>
            <ZapIcon className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold text-emerald-300">
              ~{formatTokens(tokenSavings.estimatedSavedTokens)}
            </span>
            <span className="text-[10px] font-mono text-emerald-500/80">saved</span>
          </div>
        </div>
      </div>

      {/* Accurate In / Out Token Telemetry */}
      <div className="mb-3 rounded-lg border border-zinc-800/80 bg-[#121318] p-2.5 text-[11px] shadow-sm">
        <div className="flex items-center justify-between pb-2 border-b border-zinc-800/70">
          <span className="font-semibold text-zinc-200">Content In / Out Breakdown</span>
          <span className="font-mono text-[10px] text-zinc-500">
            Total {formatChars(summary.totalInChars + summary.totalOutChars)}
          </span>
        </div>

        {/* Split In/Out Cards */}
        <div className="grid grid-cols-2 gap-2 pt-2 mb-2">
          {/* Input (Prompt / Command Args) */}
          <div className="rounded bg-zinc-900/80 p-2 border border-zinc-800/60">
            <div className="flex items-center justify-between text-zinc-400 mb-1">
              <span className="text-[10px] text-sky-400 font-medium">📥 Input (Prompt / Args)</span>
              <span className="font-mono text-[10px] text-zinc-400">{totalInPct}%</span>
            </div>
            <div className="font-mono text-sm font-bold text-zinc-100">
              {formatTokens(summary.totalInTokens)} <span className="text-[10px] text-zinc-500 font-normal">tok</span>
            </div>
            <div className="text-[9px] font-mono text-zinc-500 mt-0.5">
              ~{summary.avgInTokensPerCall} tok/call · {formatChars(summary.totalInChars)}
            </div>
          </div>

          {/* Output (Tool Return Payload) */}
          <div className="rounded bg-zinc-900/80 p-2 border border-zinc-800/60">
            <div className="flex items-center justify-between text-zinc-400 mb-1">
              <span className="text-[10px] text-indigo-400 font-medium">📤 Output (Tool Result)</span>
              <span className="font-mono text-[10px] text-zinc-400">{totalOutPct}%</span>
            </div>
            <div className="font-mono text-sm font-bold text-zinc-100">
              {formatTokens(summary.totalOutTokens)} <span className="text-[10px] text-zinc-500 font-normal">tok</span>
            </div>
            <div className="text-[9px] font-mono text-zinc-500 mt-0.5">
              ~{summary.avgOutTokensPerCall} tok/call · {formatChars(summary.totalOutChars)}
            </div>
          </div>
        </div>

        {/* Dual Color Ratio Bar */}
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden flex">
          <div
            className="h-full bg-sky-400 transition-all duration-300"
            style={{ width: `${Math.max(3, totalInPct)}%` }}
            title={`Input: ${totalInPct}%`}
          />
          <div
            className="h-full bg-indigo-500 transition-all duration-300"
            style={{ width: `${Math.max(3, totalOutPct)}%` }}
            title={`Output: ${totalOutPct}%`}
          />
        </div>
      </div>

      {/* Savings Breakdown Banner */}
      {tokenSavings.estimatedSavedTokens > 0 && (
        <div className="mb-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5 text-[11px]">
          <div className="flex items-center justify-between text-zinc-400 mb-1.5">
            <span className="font-medium text-zinc-300 flex items-center gap-1.5">
              <ZapIcon className="w-3 h-3 text-emerald-400" /> Token Efficiency Breakdown
            </span>
            <span className="font-mono text-[10px] text-emerald-400 font-semibold">
              +~{formatTokens(tokenSavings.estimatedSavedTokens)} tok
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5 pt-1 text-[10px] font-mono">
            <div className="rounded bg-zinc-800/50 p-1 text-center">
              <div className="text-zinc-500">Flow Batching</div>
              <div className="text-emerald-400 font-bold">~{formatTokens(tokenSavings.savingsBreakdown.fromFlowBatching)}</div>
            </div>
            <div className="rounded bg-zinc-800/50 p-1 text-center">
              <div className="text-zinc-500">Compact Snap</div>
              <div className="text-emerald-400 font-bold">~{formatTokens(tokenSavings.savingsBreakdown.fromCompactSnapshots)}</div>
            </div>
            <div className="rounded bg-zinc-800/50 p-1 text-center">
              <div className="text-zinc-500">Docs Blocks</div>
              <div className="text-emerald-400 font-bold">~{formatTokens(tokenSavings.savingsBreakdown.fromDocsBlocks)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Token Breakdown by Command */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
            Token Usage by Action
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            {byCommand.length} actions
          </span>
        </div>

        {byCommand.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[11px] text-zinc-500">
            No tool calls recorded in this session yet.
          </div>
        ) : (
          <div className="space-y-1.5">
            {byCommand.map((cmd) => (
              <div
                key={cmd.cmd}
                className="rounded-md border border-zinc-800/70 bg-[#121318] p-2 hover:border-zinc-700/80 transition"
              >
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <div className="flex items-center gap-1.5 font-mono font-medium text-zinc-200">
                    <span className="text-indigo-400">{cmd.cmd}</span>
                    <span className="text-[10px] text-zinc-500">x{cmd.count}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-zinc-400 font-semibold">{formatTokens(cmd.totalTokens)} tok</span>
                    <span className="text-zinc-500">({cmd.pctOfTokens}%)</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 transition-all duration-300"
                    style={{ width: `${Math.max(4, cmd.pctOfTokens)}%` }}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[9px] font-mono text-zinc-500">
                  <div className="flex items-center gap-2">
                    <span className="text-sky-400/80">📥 {formatTokens(cmd.inTokens)} in</span>
                    <span className="text-indigo-400/80">📤 {formatTokens(cmd.outTokens)} out</span>
                  </div>
                  <span>avg: ~{cmd.avgTokens} tok · {cmd.avgDurationMs}ms</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Live Tool Call Activity Stream */}
      <div className="mb-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
            Live Tool Activity Stream
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            Last {recentCalls.length} calls
          </span>
        </div>

        {recentCalls.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[11px] text-zinc-500">
            Waiting for MCP tool calls...
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-0.5">
            {recentCalls.map((call) => {
              const isExpanded = expandedCallId === call.id;
              return (
                <div
                  key={call.id}
                  className={`rounded-md border text-[11px] transition ${
                    call.isError
                      ? "border-rose-900/50 bg-rose-950/20"
                      : "border-zinc-800/80 bg-[#111216] hover:border-zinc-700/80"
                  }`}
                >
                  <div
                    className="flex items-center justify-between p-2 cursor-pointer select-none"
                    onClick={() => setExpandedCallId(isExpanded ? null : call.id)}
                  >
                    <div className="flex items-center gap-1.5 font-mono min-w-0">
                      {call.isError ? (
                        <CrossIcon className="w-3 h-3 text-rose-400 flex-none" />
                      ) : (
                        <CheckIcon className="w-3 h-3 text-emerald-400 flex-none" />
                      )}
                      <span className="font-semibold text-zinc-200 truncate">{call.cmd}</span>
                      {call.stepCount && call.stepCount > 0 && (
                        <span className="text-[9px] text-indigo-300 bg-indigo-950/60 px-1 rounded border border-indigo-900/50 flex-none">
                          {call.stepCount} steps
                        </span>
                      )}
                      {call.argsSummary && (
                        <span className="text-[10px] text-zinc-500 truncate max-w-[100px]">
                          {call.argsSummary}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 font-mono text-[10px] flex-none">
                      <span className="text-zinc-500">{call.durationMs}ms</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] text-sky-400/80 bg-sky-950/40 px-1 rounded border border-sky-900/40">
                          +{call.inTokens} in
                        </span>
                        <span className="text-[9px] text-indigo-400/80 bg-indigo-950/40 px-1 rounded border border-indigo-900/40">
                          +{call.outTokens} out
                        </span>
                      </div>
                      <ChevronDownIcon
                        className={`w-3 h-3 text-zinc-500 transition-transform ${
                          isExpanded ? "rotate-180 text-zinc-300" : ""
                        }`}
                      />
                    </div>
                  </div>

                  {/* Expanded Call Detail */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800/80 bg-[#0a0b0e] p-2 text-[10px] font-mono">
                      <div className="flex justify-between text-zinc-500 mb-1">
                        <span>Time: {formatTime(call.createdAt)}</span>
                        <span>Total: ~{call.approxTokens} tok ({call.inTokens} in / {call.outTokens} out)</span>
                        <span>Source: {call.source}</span>
                      </div>
                      {call.preview && (
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-zinc-900/90 p-1.5 text-zinc-300 max-h-32 border border-zinc-800/50">
                          {call.preview}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

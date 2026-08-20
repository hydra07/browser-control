import React, { useCallback, useEffect, useState } from "react";
import { getStatus, listFlows, type DaemonStatus, type FlowMeta } from "./lib/api";
import { FlowList } from "./components/FlowList";
import { SettingsTab } from "./components/SettingsTab";
import { BenchmarkTab } from "./components/BenchmarkTab";
import {
  WorkflowIcon,
  SettingsIcon,
  RefreshIcon,
  ChartBarIcon,
  AppLogo,
  CrossIcon,
} from "./components/Icons";

type TabKey = "flows" | "benchmark" | "settings";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; flows: FlowMeta[] }
  | { status: "unreachable"; message: string };

const POLL_MS = 5000;

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("flows");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [flows, status] = await Promise.all([listFlows(), getStatus()]);
      setState({ status: "loaded", flows });
      setDaemonStatus(status);
    } catch (e) {
      setState({
        status: "unreachable",
        message: e instanceof Error ? e.message : String(e),
      });
      setDaemonStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Global Keyboard Navigation Shortcuts inside Sidepanel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isInput) return;

      if (e.key === "1") {
        setActiveTab("flows");
      } else if (e.key === "2") {
        setActiveTab("benchmark");
      } else if (e.key === "3") {
        setActiveTab("settings");
      } else if (e.key === "r" || e.key === "R") {
        void handleRefresh();
      } else if (e.key === "Escape") {
        window.close();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function handleRefresh() {
    setIsRefreshing(true);
    await load();
    setTimeout(() => setIsRefreshing(false), 300);
  }

  function handleClosePanel() {
    window.close();
  }

  const isConnected = daemonStatus?.extensionConnected ?? false;
  const flowCount = state.status === "loaded" ? state.flows.length : 0;

  return (
    <div className="flex h-screen w-full bg-[#0c0d11] text-zinc-100 overflow-hidden font-sans select-none antialiased animate-fade-in">
      {/* Activity Bar Rail */}
      <aside className="flex w-11 flex-none flex-col items-center justify-between border-r border-zinc-800/80 bg-[#08090c] py-3 z-10">
        {/* Top Section: App Logo & Navigation Tabs */}
        <div className="flex flex-col items-center gap-3 w-full">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800/90 text-indigo-400 shadow-sm transition hover:border-indigo-500/50 hover:scale-105"
            title="BrowserControl Agent"
          >
            <AppLogo className="w-4 h-4" />
          </div>

          <div className="h-px w-5 bg-zinc-800/70" />

          {/* Navigation Icons */}
          <nav className="flex flex-col items-center gap-1.5 w-full px-1">
            {/* Flows Tab Button */}
            <button
              type="button"
              onClick={() => setActiveTab("flows")}
              title={`Automated Flows (${flowCount}) [1]`}
              className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 active:scale-95 ${
                activeTab === "flows"
                  ? "bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700/60"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {activeTab === "flows" && (
                <span className="absolute -left-1 top-2 bottom-2 w-[2.5px] bg-indigo-400 rounded-r shadow-[0_0_6px_rgba(129,140,248,0.7)]" />
              )}
              <WorkflowIcon className="w-4 h-4 transition-transform group-hover:scale-110" />
            </button>

            {/* Benchmark Tab Button */}
            <button
              type="button"
              onClick={() => setActiveTab("benchmark")}
              title="Token Analytics & Telemetry [2]"
              className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 active:scale-95 ${
                activeTab === "benchmark"
                  ? "bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700/60"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {activeTab === "benchmark" && (
                <span className="absolute -left-1 top-2 bottom-2 w-[2.5px] bg-indigo-400 rounded-r shadow-[0_0_6px_rgba(129,140,248,0.7)]" />
              )}
              <ChartBarIcon className="w-4 h-4 transition-transform group-hover:scale-110" />
            </button>

            {/* Settings Tab Button */}
            <button
              type="button"
              onClick={() => setActiveTab("settings")}
              title="Settings & Diagnostics [3]"
              className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 active:scale-95 ${
                activeTab === "settings"
                  ? "bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700/60"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {activeTab === "settings" && (
                <span className="absolute -left-1 top-2 bottom-2 w-[2.5px] bg-indigo-400 rounded-r shadow-[0_0_6px_rgba(129,140,248,0.7)]" />
              )}
              <SettingsIcon className="w-4 h-4 transition-transform group-hover:scale-110" />
            </button>
          </nav>
        </div>

        {/* Bottom Section: Sync & Live Connection Status Dot */}
        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            title="Sync State [R]"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition active:scale-90"
          >
            <RefreshIcon className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-indigo-400" : ""}`} />
          </button>

          <div
            title={isConnected ? "Daemon Paired (Live CDP Bridge Active)" : "Daemon Offline / Unpaired"}
            className="flex h-5 w-5 items-center justify-center cursor-pointer group"
            onClick={() => setActiveTab("settings")}
          >
            <span
              className={`h-2 w-2 rounded-full transition-all duration-300 ${
                isConnected
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)] animate-pulse-glow"
                  : "bg-amber-400/80 shadow-[0_0_4px_rgba(251,191,36,0.5)]"
              }`}
            />
          </div>
        </div>
      </aside>

      {/* Main Panel Content Container */}
      <main className="flex flex-1 flex-col min-w-0 bg-[#0c0d11] overflow-hidden">
        {/* Top Header */}
        <header className="flex flex-none items-center justify-between border-b border-zinc-800/80 px-3.5 py-2.5 glass-header z-10">
          <div className="flex items-center gap-2">
            <h2 className="text-[12px] font-semibold tracking-tight text-zinc-100 flex items-center gap-1.5">
              {activeTab === "flows"
                ? "Automated Flows"
                : activeTab === "benchmark"
                  ? "Token Telemetry & Metrics"
                  : "Settings & Setup"}
            </h2>
            {activeTab === "flows" && flowCount > 0 && (
              <span className="rounded-full bg-zinc-800/80 px-2 py-0.2 font-mono text-[10px] text-zinc-400 border border-zinc-700/40">
                {flowCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 font-mono text-[10px]">
            <span
              className={`px-1.5 py-0.5 rounded border transition-colors ${
                isConnected
                  ? "bg-emerald-950/40 text-emerald-400 border-emerald-900/50 shadow-[0_0_6px_rgba(52,211,153,0.15)]"
                  : "bg-amber-950/40 text-amber-400 border-amber-900/50"
              }`}
            >
              {isConnected ? "READY" : "OFFLINE"}
            </span>

            {/* Native Close Button */}
            <button
              type="button"
              onClick={handleClosePanel}
              title="Close Side Panel (Esc)"
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition active:scale-95"
            >
              <CrossIcon className="w-3 h-3" />
            </button>
          </div>
        </header>

        {/* Tab View Transition Container */}
        <div key={activeTab} className="flex-1 flex flex-col min-h-0 overflow-hidden animate-fade-in">
          {activeTab === "flows" ? (
            <>
              {state.status === "loading" && (
                <div className="flex flex-1 items-center justify-center p-6 text-zinc-500 font-mono text-[11px]">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 animate-spin rounded-full border border-indigo-400 border-t-transparent" />
                    <span>Connecting to daemon...</span>
                  </div>
                </div>
              )}

              {state.status === "unreachable" && (
                <div className="flex flex-1 flex-col items-center justify-center p-6 text-center animate-fade-in">
                  <div className="font-semibold text-zinc-200 text-xs">Daemon Unreachable</div>
                  <p className="mt-1 text-[11px] text-zinc-500 max-w-[220px] leading-relaxed">
                    {state.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    className="mt-3.5 rounded-lg bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 transition"
                  >
                    Retry Connection
                  </button>
                </div>
              )}

              {state.status === "loaded" && (
                <FlowList
                  flows={state.flows}
                  onFlowDeleted={(id) =>
                    setState((s) =>
                      s.status === "loaded"
                        ? { ...s, flows: s.flows.filter((f) => f.id !== id) }
                        : s,
                    )
                  }
                />
              )}
            </>
          ) : activeTab === "benchmark" ? (
            <BenchmarkTab onRefresh={() => void handleRefresh()} />
          ) : (
            <SettingsTab daemonStatus={daemonStatus} onRefresh={() => void handleRefresh()} />
          )}
        </div>
      </main>
    </div>
  );
}

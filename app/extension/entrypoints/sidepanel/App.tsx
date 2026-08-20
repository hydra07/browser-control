import React, { useCallback, useEffect, useState } from "react";
import { getStatus, listFlows, type DaemonStatus, type FlowMeta } from "./lib/api";
import { FlowList } from "./components/FlowList";
import { SettingsTab } from "./components/SettingsTab";
import {
  WorkflowIcon,
  SettingsIcon,
  RefreshIcon,
  AppLogo,
} from "./components/Icons";

type TabKey = "flows" | "settings";

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

  async function handleRefresh() {
    setIsRefreshing(true);
    await load();
    setTimeout(() => setIsRefreshing(false), 300);
  }

  const isConnected = daemonStatus?.extensionConnected ?? false;
  const flowCount = state.status === "loaded" ? state.flows.length : 0;

  return (
    <div className="flex h-screen w-full bg-[#0d0e12] text-zinc-100 overflow-hidden font-sans select-none antialiased">
      {/* Activity Bar Rail */}
      <aside className="flex w-11 flex-none flex-col items-center justify-between border-r border-zinc-800/80 bg-[#090a0d] py-3 z-10">
        {/* Top Section: App Logo & Tabs */}
        <div className="flex flex-col items-center gap-3 w-full">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200 shadow-sm" title="BrowserControl DevTools">
            <AppLogo className="w-4 h-4" />
          </div>

          <div className="h-px w-5 bg-zinc-800/80" />

          {/* Navigation Icons */}
          <nav className="flex flex-col items-center gap-1.5 w-full px-1">
            {/* Flows Tab Button */}
            <button
              type="button"
              onClick={() => setActiveTab("flows")}
              title={`Automated Flows (${flowCount})`}
              className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition active:scale-95 ${
                activeTab === "flows"
                  ? "bg-zinc-800 text-white shadow-sm"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {activeTab === "flows" && (
                <span className="absolute -left-1 top-2 bottom-2 w-[2.5px] bg-indigo-400 rounded-r shadow-[0_0_6px_rgba(129,140,248,0.6)]" />
              )}
              <WorkflowIcon className="w-4 h-4" />
            </button>

            {/* Settings Tab Button */}
            <button
              type="button"
              onClick={() => setActiveTab("settings")}
              title="Settings & Diagnostics"
              className={`group relative flex h-8 w-8 items-center justify-center rounded-lg transition active:scale-95 ${
                activeTab === "settings"
                  ? "bg-zinc-800 text-white shadow-sm"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {activeTab === "settings" && (
                <span className="absolute -left-1 top-2 bottom-2 w-[2.5px] bg-indigo-400 rounded-r shadow-[0_0_6px_rgba(129,140,248,0.6)]" />
              )}
              <SettingsIcon className="w-4 h-4" />
            </button>
          </nav>
        </div>

        {/* Bottom Section: Sync & Live Connection Dot */}
        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            title="Sync State"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition active:scale-90"
          >
            <RefreshIcon className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-zinc-200" : ""}`} />
          </button>

          <div
            title={isConnected ? "Daemon Paired (WebSocket Connected)" : "Daemon Offline / Unpaired"}
            className="flex h-5 w-5 items-center justify-center cursor-pointer group"
            onClick={() => setActiveTab("settings")}
          >
            <span
              className={`h-2 w-2 rounded-full ring-2 transition ${
                isConnected
                  ? "bg-emerald-400 ring-emerald-500/20 shadow-[0_0_8px_rgba(52,211,153,0.5)]"
                  : "bg-amber-400 ring-amber-500/20"
              }`}
            />
          </div>
        </div>
      </aside>

      {/* Main Panel Content */}
      <main className="flex flex-1 flex-col min-w-0 bg-[#0d0e12] overflow-hidden">
        {/* Top Header */}
        <header className="flex flex-none items-center justify-between border-b border-zinc-800/80 px-3.5 py-2.5 bg-[#101116]/80 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <h2 className="text-[12px] font-semibold tracking-tight text-zinc-100">
              {activeTab === "flows" ? "Automated Flows" : "Settings & Setup"}
            </h2>
            {activeTab === "flows" && flowCount > 0 && (
              <span className="rounded-full bg-zinc-800/80 px-2 py-0.2 font-mono text-[10px] text-zinc-400 border border-zinc-700/40">
                {flowCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 font-mono text-[10px]">
            <span
              className={`px-1.5 py-0.5 rounded border ${
                isConnected
                  ? "bg-emerald-950/40 text-emerald-400 border-emerald-900/50"
                  : "bg-amber-950/40 text-amber-400 border-amber-900/50"
              }`}
            >
              {isConnected ? "READY" : "OFFLINE"}
            </span>
          </div>
        </header>

        {/* Tab View */}
        {activeTab === "flows" ? (
          <>
            {state.status === "loading" && (
              <div className="flex flex-1 items-center justify-center p-6 text-zinc-500 font-mono text-[11px]">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
                  <span>Connecting to daemon...</span>
                </div>
              </div>
            )}

            {state.status === "unreachable" && (
              <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
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
        ) : (
          <SettingsTab daemonStatus={daemonStatus} onRefresh={() => void handleRefresh()} />
        )}
      </main>
    </div>
  );
}

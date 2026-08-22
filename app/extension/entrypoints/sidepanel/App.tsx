import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { getSettings, type Settings } from "../../configs/settings.js";
import { BenchmarkTab } from "./components/BenchmarkTab";
import { ChatTab } from "./components/ChatTab";
import { FlowList } from "./components/FlowList";
import {
  AppLogo,
  ChartBarIcon,
  ChatIcon,
  CrossIcon,
  RefreshIcon,
  SettingsIcon,
  WorkflowIcon,
} from "./components/Icons";
import { SettingsTab } from "./components/SettingsTab";
import { type DaemonStatus, type FlowMeta, getStatus, listFlows } from "./lib/api";

type TabKey = "flows" | "benchmark" | "chat" | "settings";

type PanelStyle = CSSProperties & Record<`--bc-${string}`, number | string>;

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; flows: FlowMeta[] }
  | { status: "unreachable"; message: string };

const POLL_MS = 5000;

function NavItem({
  active,
  icon,
  label,
  shortcut,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={`${label} [${shortcut}]`}
      className="bc-nav-item"
    >
      {icon}
      <span className="bc-nav-label">{label}</span>
      <span className="bc-nav-key">{shortcut}</span>
    </button>
  );
}

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("flows");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [flows, status, currentSettings] = await Promise.all([listFlows(), getStatus(), getSettings()]);
      setState({ status: "loaded", flows });
      setDaemonStatus(status);
      setSettings(currentSettings);
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

  const isChatEnabled = settings?.chatEnabled ?? false;

  useEffect(() => {
    if (!isChatEnabled && activeTab === "chat") {
      setActiveTab("flows");
    }
  }, [isChatEnabled, activeTab]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setTimeout(() => setIsRefreshing(false), 250);
  }, [load]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isInput) return;

      if (e.key === "1") {
        setActiveTab("flows");
      } else if (e.key === "2") {
        setActiveTab("benchmark");
      } else if (e.key === "3" && isChatEnabled) {
        setActiveTab("chat");
      } else if (e.key === "4" || (e.key === "3" && !isChatEnabled)) {
        setActiveTab("settings");
      } else if (e.key === "r" || e.key === "R") {
        void handleRefresh();
      } else if (e.key === "Escape") {
        window.close();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isChatEnabled, handleRefresh]);

  useEffect(() => {
    const app = appRef.current;
    if (!app) return;

    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const updateLight = () => {
      frame = 0;
      const bounds = app.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (pointerX - bounds.left) / Math.max(bounds.width, 1)));
      const y = Math.min(1, Math.max(0, (pointerY - bounds.top) / Math.max(bounds.height, 1)));
      app.style.setProperty("--bc-light-x", `${(x * 100).toFixed(2)}%`);
      app.style.setProperty("--bc-light-y", `${(y * 100).toFixed(2)}%`);
      app.style.setProperty("--bc-light-angle", `${Math.round(112 + x * 46)}deg`);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(updateLight);
    };

    app.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      app.removeEventListener("pointermove", handlePointerMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const isConnected = daemonStatus?.extensionConnected ?? false;
  const flowCount = state.status === "loaded" ? state.flows.length : 0;
  const navItems: ReadonlyArray<{ key: TabKey; icon: ReactNode; label: string; shortcut: string }> = [
    {
      key: "flows",
      icon: <WorkflowIcon className="h-3.5 w-3.5" />,
      label: flowCount > 0 ? `Flows · ${flowCount}` : "Flows",
      shortcut: "1",
    },
    {
      key: "benchmark",
      icon: <ChartBarIcon className="h-3.5 w-3.5" />,
      label: "Metrics",
      shortcut: "2",
    },
    ...(isChatEnabled
      ? [
          {
            key: "chat" as const,
            icon: <ChatIcon className="h-3.5 w-3.5" />,
            label: "Agent",
            shortcut: "3",
          },
        ]
      : []),
    {
      key: "settings",
      icon: <SettingsIcon className="h-3.5 w-3.5" />,
      label: "Setup",
      shortcut: isChatEnabled ? "4" : "3",
    },
  ];
  const tabbarStyle: PanelStyle = {
    "--bc-tab-index": Math.max(
      0,
      navItems.findIndex((item) => item.key === activeTab),
    ),
    "--bc-tab-width": `calc((100% - ${8 + (navItems.length - 1) * 3}px) / ${navItems.length})`,
  };

  return (
    <div
      ref={appRef}
      className="bc-app flex h-screen w-full flex-col overflow-hidden text-zinc-100 select-none antialiased animate-fade-in"
    >
      <header className="bc-topbar flex flex-none items-center justify-between px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="bc-brand-mark" title="BrowserControl Agent">
            <AppLogo className="h-4.5 w-4.5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-bold tracking-[-0.01em] text-white">BrowserControl</div>
            <div className="truncate text-[9.5px] font-medium text-slate-400">Browser operator</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            title={isConnected ? "Daemon paired" : "Daemon offline"}
            className={`bc-status ${isConnected ? "bc-status-live" : "bc-status-offline"}`}
          >
            <span className="bc-status-dot" />
            <span>{isConnected ? "LIVE" : "OFFLINE"}</span>
          </button>
          <button type="button" onClick={() => void handleRefresh()} title="Sync state [R]" className="bc-icon-button">
            <RefreshIcon className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin text-blue-300" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            title="Close side panel [Esc]"
            className="bc-icon-button"
          >
            <CrossIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <nav className="bc-tabbar" aria-label="BrowserControl sections" style={tabbarStyle}>
        <span className="bc-nav-lens" aria-hidden="true" />
        {navItems.map((item) => (
          <NavItem
            key={item.key}
            active={activeTab === item.key}
            icon={item.icon}
            label={item.label}
            shortcut={item.shortcut}
            onClick={() => setActiveTab(item.key)}
          />
        ))}
      </nav>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-2 pb-2">
        {/* Tab 1: Flows */}
        <div className={`flex-1 flex flex-col min-h-0 overflow-hidden ${activeTab === "flows" ? "flex" : "hidden"}`}>
          {state.status === "loading" && (
            <div className="flex flex-1 items-center justify-center p-6 text-slate-400 font-mono text-[11px]">
              <div className="flex items-center gap-2">
                <div className="bc-spinner" />
                <span>Connecting to daemon...</span>
              </div>
            </div>
          )}

          {state.status === "unreachable" && (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center animate-fade-in">
              <div className="font-semibold text-slate-200 text-xs">Daemon Unreachable</div>
              <p className="mt-1 text-[11px] text-slate-400 max-w-[220px] leading-relaxed">{state.message}</p>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                className="bc-primary-button mt-3.5 px-3.5 py-1.5 text-[11px]"
              >
                Retry Connection
              </button>
            </div>
          )}

          {state.status === "loaded" && (
            <FlowList
              flows={state.flows}
              onFlowDeleted={(id) =>
                setState((s) => (s.status === "loaded" ? { ...s, flows: s.flows.filter((f) => f.id !== id) } : s))
              }
              onFlowSaved={(flow) =>
                setState((s) =>
                  s.status === "loaded"
                    ? { ...s, flows: [flow, ...s.flows.filter((existing) => existing.id !== flow.id)] }
                    : s,
                )
              }
            />
          )}
        </div>

        {/* Tab 2: Benchmark */}
        <div
          className={`flex-1 flex flex-col min-h-0 overflow-hidden ${activeTab === "benchmark" ? "flex" : "hidden"}`}
        >
          <BenchmarkTab onRefresh={() => void handleRefresh()} />
        </div>

        {/* Tab 3: Agent Chat (if enabled) */}
        {isChatEnabled && (
          <div className={`flex-1 flex flex-col min-h-0 overflow-hidden ${activeTab === "chat" ? "flex" : "hidden"}`}>
            <ChatTab />
          </div>
        )}

        {/* Tab 4: Settings */}
        <div className={`flex-1 flex flex-col min-h-0 overflow-hidden ${activeTab === "settings" ? "flex" : "hidden"}`}>
          <SettingsTab daemonStatus={daemonStatus} onRefresh={() => void handleRefresh()} />
        </div>
      </main>
    </div>
  );
}

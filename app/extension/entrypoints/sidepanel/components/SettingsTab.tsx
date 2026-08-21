import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  getSettings,
  type Settings,
  saveSettings,
  TAB_GROUP_COLORS,
  type TabGroupColor,
} from "../../../configs/settings.js";
import { abortCliAgent, type CliAgentQueryResult, type DaemonStatus, queryCliAgent } from "../lib/api";
import { ChatIcon, CheckIcon, CopyIcon, PinIcon, RefreshIcon, SparklesIcon, TerminalIcon, ZapIcon } from "./Icons";

interface SettingsTabProps {
  daemonStatus: DaemonStatus | null;
  onRefresh: () => void;
}

const COLOR_SWATCH: Record<TabGroupColor, string> = {
  grey: "#9aa0a6",
  blue: "#8ab4f8",
  red: "#f28b82",
  yellow: "#fdd663",
  green: "#81c995",
  pink: "#ff8bcb",
  purple: "#d7aefb",
  cyan: "#78d9ec",
  orange: "#fcad70",
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
        checked ? "bg-emerald-500" : "bg-zinc-700"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

const inputClass =
  "mt-1.5 w-full rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-zinc-600 transition";

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      browsercontrol: {
        command: "bun",
        args: ["run", "app/server/src/daemon.ts"],
      },
    },
  },
  null,
  2,
);

const DEFAULT_TEST_PROMPT = "Tóm tắt ngắn gọn các ý chính của trang web này giúp tôi.";

function BehaviorSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<CliAgentQueryResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    };
  }, []);

  function flashSaved() {
    setShowSaved(true);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => setShowSaved(false), 1500);
  }

  function commit(patch: Partial<Settings>, opts: { debounce?: boolean } = {}) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const run = () => {
      void saveSettings(patch).then(flashSaved);
    };
    if (opts.debounce) saveTimer.current = setTimeout(run, 500);
    else run();
  }

  async function handleRunCliAgentTest() {
    if (!testPrompt.trim()) return;
    setIsRunningTest(true);
    setTestResult(null);
    setTestError(null);

    try {
      // Ping active tab context
      let url = "";
      let title = "";
      let selectionText = "";
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && tab.url) {
          url = tab.url;
          title = tab.title || "";
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.getSelection()?.toString() || "",
          });
          selectionText = results?.[0]?.result?.trim() || "";
        }
      } catch {}

      const res = await queryCliAgent({
        prompt: testPrompt.trim(),
        url: url || undefined,
        title: title || undefined,
        selectionText: selectionText || undefined,
        customCommand: settings?.cliAgentCommand,
      });

      setTestResult(res);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunningTest(false);
    }
  }

  async function handleAbortTest() {
    try {
      await abortCliAgent();
      setIsRunningTest(false);
    } catch {}
  }

  if (!settings) return null;

  return (
    <>
      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium text-zinc-200 text-[11.5px]">Tab group</div>
          <span
            className={`flex items-center gap-1 text-[10px] font-mono text-emerald-400 transition-opacity duration-300 ${
              showSaved ? "opacity-100" : "opacity-0"
            }`}
          >
            <CheckIcon className="w-2.5 h-2.5" /> saved
          </span>
        </div>

        <label className="block">
          <div className="text-[10.5px] text-zinc-500">Name</div>
          <input
            type="text"
            value={settings.tabGroupName}
            onChange={(e) => commit({ tabGroupName: e.target.value }, { debounce: true })}
            className={inputClass}
          />
        </label>

        <div>
          <div className="text-[10.5px] text-zinc-500">Color</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {TAB_GROUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => commit({ tabGroupColor: c })}
                className={`h-5 w-5 rounded-full ring-2 ring-offset-2 ring-offset-[#16161a] transition-transform hover:scale-110 ${
                  settings.tabGroupColor === c ? "ring-white/80" : "ring-transparent"
                }`}
                style={{ backgroundColor: COLOR_SWATCH[c] }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-zinc-200 text-[11.5px]">Visible cursor animation</div>
            <div className="mt-1 text-[10.5px] leading-snug text-zinc-500">
              Glide + ripple on click/type/press_key/scroll/drag. Off is faster but harder to watch.
            </div>
          </div>
          <Toggle checked={settings.animationsEnabled} onChange={(v) => commit({ animationsEnabled: v })} />
        </div>
      </div>

      <div className="rounded-md border border-indigo-900/40 bg-[#13141c] p-3 space-y-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-zinc-100 text-[11.5px]">
            <SparklesIcon className="w-3.5 h-3.5 text-indigo-400" />
            <span>CLI Agents Execution (Experiment)</span>
          </div>
          <span className="rounded bg-indigo-950/80 px-1.5 py-0.2 font-mono text-[9px] text-indigo-300 border border-indigo-800/60">
            LABS
          </span>
        </div>

        <p className="text-[10.5px] text-zinc-400 leading-relaxed">
          Tùy chỉnh lệnh CLI Agent (Claude Code / Antigravity CLI) chạy trong sandbox để tận dụng gói subscription của
          bạn.
        </p>

        <label className="block">
          <div className="flex items-center justify-between text-[10.5px] text-zinc-400">
            <span>CLI Command Template</span>
            <span className="text-[9.5px] font-mono text-zinc-500">Customizable</span>
          </div>
          <input
            type="text"
            value={settings.cliAgentCommand ?? "claude --print"}
            onChange={(e) => commit({ cliAgentCommand: e.target.value }, { debounce: true })}
            placeholder="e.g. claude --print or agy -p"
            className={inputClass}
          />
          <p className="mt-1 text-[9.5px] text-zinc-500 leading-relaxed">
            Base binary + flags only. When this starts with `claude`, streaming, session resume, and read-only
            page-inspection tool access are added automatically.
          </p>
        </label>

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-[10px] text-zinc-500">Presets:</span>
          <button
            type="button"
            onClick={() => commit({ cliAgentCommand: "claude --print" })}
            className="rounded bg-zinc-900 hover:bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-300 border border-zinc-800 transition"
          >
            Claude Code
          </button>
          <button
            type="button"
            onClick={() => commit({ cliAgentCommand: "agy -p" })}
            className="rounded bg-zinc-900 hover:bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-300 border border-zinc-800 transition"
          >
            Antigravity
          </button>
          <button
            type="button"
            onClick={() => commit({ cliAgentCommand: "agy --effort low -p" })}
            className="flex items-center gap-1 rounded bg-zinc-900 hover:bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-emerald-400 border border-emerald-950 transition"
            title="Fast response mode with reduced reasoning latency"
          >
            <ZapIcon className="w-2.5 h-2.5" /> agy (Fast)
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-zinc-800/80">
          <div>
            <div className="font-medium text-zinc-200 text-[11px] flex items-center gap-1.5">
              <ChatIcon className="w-3.5 h-3.5 text-indigo-400" />
              <span>Hiển thị Tab Chat trên thanh điều hướng</span>
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-zinc-400">
              Bật tab Chat để trò chuyện, hỏi đáp và ping trang trực tiếp với CLI Agent (Default: Tắt).
            </div>
          </div>
          <Toggle checked={settings.chatEnabled ?? false} onChange={(v) => commit({ chatEnabled: v })} />
        </div>

        <div className="pt-2 border-t border-zinc-800/80 space-y-2">
          <div className="text-[10.5px] font-medium text-zinc-300">Test Execution & Ping Context</div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={testPrompt}
              onChange={(e) => setTestPrompt(e.target.value)}
              placeholder="Prompt for active page..."
              disabled={isRunningTest}
              className="flex-1 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-indigo-500/50"
            />
            {isRunningTest ? (
              <button
                type="button"
                onClick={handleAbortTest}
                className="rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800/60 px-2.5 py-1 text-[11px] font-medium text-rose-300 transition"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRunCliAgentTest}
                disabled={!testPrompt.trim()}
                className="flex items-center gap-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition active:scale-95"
              >
                <PinIcon className="w-3 h-3" />
                <span>Ping & Run</span>
              </button>
            )}
          </div>

          {isRunningTest && (
            <div className="flex items-center gap-2 rounded bg-zinc-950 p-2 text-[10.5px] text-indigo-300 font-mono border border-indigo-900/40 animate-pulse">
              <div className="h-3 w-3 animate-spin rounded-full border border-indigo-400 border-t-transparent flex-none" />
              <span>Executing CLI Agent in sandbox...</span>
            </div>
          )}

          {testResult && (
            <div className="rounded bg-zinc-950 p-2.5 border border-zinc-800 text-[10.5px] font-mono space-y-1.5 animate-fade-in">
              <div className="flex items-center justify-between text-zinc-500 text-[9.5px]">
                <span className="truncate max-w-[200px]">Cmd: {testResult.commandUsed}</span>
                <span className="text-emerald-400">{testResult.durationMs}ms</span>
              </div>
              <div className="text-zinc-200 whitespace-pre-wrap leading-relaxed select-text font-sans text-[11px]">
                {testResult.content}
              </div>
            </div>
          )}

          {testError && (
            <div className="rounded bg-rose-950/40 p-2 border border-rose-900/50 text-[10.5px] font-mono text-rose-300">
              Error: {testError}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-3">
        <div className="font-medium text-zinc-200 text-[11.5px]">Recording</div>
        <label className="block">
          <div className="text-[10.5px] text-zinc-500">Quality — {settings.recordingQuality}</div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={settings.recordingQuality}
            onChange={(e) => commit({ recordingQuality: Number(e.target.value) })}
            className="mt-2 w-full accent-emerald-500"
          />
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block">
            <div className="text-[10.5px] text-zinc-500">Max width</div>
            <input
              type="number"
              min={320}
              max={3840}
              step={16}
              value={settings.recordingMaxWidth}
              onChange={(e) =>
                commit(
                  { recordingMaxWidth: Number(e.target.value) || DEFAULT_SETTINGS.recordingMaxWidth },
                  { debounce: true },
                )
              }
              className={inputClass}
            />
          </label>
          <label className="block">
            <div className="text-[10.5px] text-zinc-500">Max height</div>
            <input
              type="number"
              min={240}
              max={2160}
              step={16}
              value={settings.recordingMaxHeight}
              onChange={(e) =>
                commit(
                  { recordingMaxHeight: Number(e.target.value) || DEFAULT_SETTINGS.recordingMaxHeight },
                  { debounce: true },
                )
              }
              className={inputClass}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => {
            setSettings(DEFAULT_SETTINGS);
            void saveSettings(DEFAULT_SETTINGS).then(flashSaved);
          }}
          className="text-[10.5px] text-zinc-500 hover:text-zinc-300"
        >
          Reset to defaults
        </button>
      </div>
    </>
  );
}

export function SettingsTab({ daemonStatus, onRefresh }: SettingsTabProps) {
  const [pinging, setPinging] = useState(false);
  const [pingState, setPingState] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handlePing() {
    setPinging(true);
    const start = performance.now();
    try {
      const res = await fetch("http://127.0.0.1:8765/status");
      const ms = Math.round(performance.now() - start);
      if (res.ok) setPingState(`${ms}ms (OK)`);
      else setPingState(`HTTP ${res.status}`);
    } catch {
      setPingState("Failed (Offline)");
    } finally {
      setPinging(false);
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(MCP_CONFIG);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="font-medium text-zinc-200 text-[11.5px]">Daemon Connection</div>
          <div className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                daemonStatus?.extensionConnected
                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
                  : "bg-amber-400"
              }`}
            />
            <span className="text-[10px] font-mono text-zinc-400">
              {daemonStatus?.extensionConnected ? "PAIRED" : "UNPAIRED"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[10.5px]">
          <div className="rounded bg-zinc-900 p-2 border border-zinc-800">
            <div className="text-zinc-500 text-[10px]">MCP PROTOCOL</div>
            <div className="mt-0.5 text-zinc-300">stdio (Active)</div>
          </div>
          <div className="rounded bg-zinc-900 p-2 border border-zinc-800">
            <div className="text-zinc-500 text-[10px]">DAEMON VERSION</div>
            <div className="mt-0.5 text-zinc-300">{daemonStatus?.version ?? "0.1.0"}</div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
          <button
            type="button"
            onClick={handlePing}
            disabled={pinging}
            className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[10.5px] text-zinc-300 hover:bg-zinc-700 active:bg-zinc-600 transition"
          >
            <RefreshIcon className={`w-3 h-3 ${pinging ? "animate-spin" : ""}`} />
            <span>{pingState ? `Latency: ${pingState}` : "Ping Daemon"}</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            className="text-[10.5px] text-zinc-400 hover:text-zinc-200 transition"
          >
            Refresh State
          </button>
        </div>
      </div>

      <BehaviorSettings />

      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-medium text-zinc-200 text-[11.5px]">
            <TerminalIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span>MCP Config</span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[10.5px] text-zinc-300 hover:bg-zinc-700 transition"
          >
            <CopyIcon className="w-3 h-3" />
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>

        <pre className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300 border border-zinc-800/80">
          {MCP_CONFIG}
        </pre>
      </div>

      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-2">
        <div className="font-medium text-zinc-200 text-[11.5px]">Extension Setup</div>
        <div className="space-y-1.5 text-[10.5px]">
          <div className="flex items-center justify-between rounded bg-zinc-900 p-2 border border-zinc-800">
            <span className="text-zinc-400">Extension Manage URL</span>
            <span className="font-mono text-zinc-300">chrome://extensions</span>
          </div>
          <div className="flex items-center justify-between rounded bg-zinc-900 p-2 border border-zinc-800">
            <span className="text-zinc-400">CDP Protocol Mode</span>
            <span className="font-mono text-emerald-400">Native Attached</span>
          </div>
        </div>
      </div>
    </div>
  );
}

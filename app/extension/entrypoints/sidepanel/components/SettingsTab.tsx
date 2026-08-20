import React, { useEffect, useRef, useState } from "react";
import type { DaemonStatus } from "../lib/api";
import { TerminalIcon, CopyIcon, RefreshIcon } from "./Icons";
import {
  DEFAULT_SETTINGS,
  TAB_GROUP_COLORS,
  getSettings,
  saveSettings,
  type Settings,
  type TabGroupColor,
} from "../../../lib/settings.js";

interface SettingsTabProps {
  daemonStatus: DaemonStatus | null;
  onRefresh: () => void;
}

// Matches chrome.tabGroups' actual on-screen colors closely enough to
// preview a choice before saving it.
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

// Extension behavior settings (chrome.storage-backed, lib/settings.ts) —
// separate card group from the connection diagnostics above, but same
// container styling so the panel reads as one settings screen, not two
// bolted-together ones.
function BehaviorSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSaved, setShowSaved] = useState(false);
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

  if (!settings) return null;

  return (
    <>
      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-medium text-zinc-200 text-[11.5px]">Tab group</div>
          <span
            className={`text-[10px] font-mono text-emerald-400 transition-opacity duration-300 ${
              showSaved ? "opacity-100" : "opacity-0"
            }`}
          >
            ✓ saved
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
          <Toggle
            checked={settings.animationsEnabled}
            onChange={(v) => commit({ animationsEnabled: v })}
          />
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
          Reset all behavior settings to defaults
        </button>
      </div>
    </>
  );
}

export function SettingsTab({ daemonStatus, onRefresh }: SettingsTabProps) {
  const [copied, setCopied] = useState(false);
  const [pingState, setPingState] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        browsercontrol: {
          command: "bun",
          args: ["run", "/absolute/path/to/browsercontrol/app/server/src/daemon.ts"],
        },
      },
    },
    null,
    2,
  );

  async function handlePing() {
    setPinging(true);
    setPingState(null);
    const t0 = performance.now();
    try {
      const res = await fetch("http://127.0.0.1:8765/status");
      const dt = Math.round(performance.now() - t0);
      if (res.ok) {
        setPingState(`${dt}ms`);
      } else {
        setPingState(`HTTP ${res.status}`);
      }
    } catch {
      setPingState("ERR");
    } finally {
      setPinging(false);
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(mcpConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isConnected = daemonStatus?.extensionConnected ?? false;

  return (
    <div className="flex-1 space-y-3.5 overflow-y-auto p-3 text-[11px]">
      {/* Daemon Status Card */}
      <div className="rounded-md border border-zinc-800 bg-[#16161a] p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="font-medium text-zinc-200 text-[11.5px]">Daemon Connection</div>
          <span
            className={`inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.2 rounded border ${
              isConnected
                ? "bg-emerald-950/50 text-emerald-400 border-emerald-900/60"
                : "bg-amber-950/50 text-amber-300 border-amber-900/60"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {isConnected ? "WS PAIRED" : "DISCONNECTED"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[10.5px] font-mono">
          <div className="rounded bg-zinc-900 p-2 border border-zinc-800">
            <div className="text-zinc-500 text-[10px]">HOST</div>
            <div className="mt-0.5 text-zinc-300">127.0.0.1:8765</div>
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

      {/* MCP Client Config */}
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
          {mcpConfig}
        </pre>
      </div>

      {/* System Diagnostics */}
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

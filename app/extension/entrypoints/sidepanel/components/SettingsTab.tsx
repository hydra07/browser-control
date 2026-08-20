import React, { useState } from "react";
import type { DaemonStatus } from "../lib/api";
import { TerminalIcon, CopyIcon, RefreshIcon } from "./Icons";

interface SettingsTabProps {
  daemonStatus: DaemonStatus | null;
  onRefresh: () => void;
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
          args: ["run", "app/server/index.ts"],
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

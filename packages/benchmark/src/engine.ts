import { computeTokenMetrics, computeTokenSavings } from "./calculator.js";
import { analyzeMemoryDrift } from "./telemetry.js";
import type { BenchmarkMetrics, RawCallRecord } from "./types.js";

declare const process:
    | {
          env?: Record<string, string | undefined>;
          memoryUsage?: () => { rss: number; heapUsed: number; heapTotal: number };
      }
    | undefined;

let cachedEnabled: boolean | null = null;

/** Checks whether active benchmark & telemetry recording is enabled via environment. */
export function isBenchmarkEnabled(): boolean {
    if (cachedEnabled !== null) {
        return cachedEnabled;
    }
    const val = process?.env ? process.env.BENCHMARK || process.env.ENABLE_BENCHMARK : undefined;
    cachedEnabled = val === "1" || val === "true";
    return cachedEnabled;
}

/** Manually set active state (useful for test runs or programmatic toggling). */
export function setBenchmarkEnabled(enabled: boolean): void {
    cachedEnabled = enabled;
}

/** Samples the current server runtime memory footprint in megabytes. */
export function sampleServerMemory(): {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
} {
    if (typeof process === "undefined" || !process?.memoryUsage) {
        return { rssMb: 0, heapUsedMb: 0, heapTotalMb: 0 };
    }
    const mem = process.memoryUsage();
    return {
        rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
    };
}

/** Aggregates raw SQLite tool call records into full benchmark metrics & telemetry report. */
export function computeMetrics(params: {
    rows: RawCallRecord[];
    sessionId: string;
    sessionName: string;
    startedAt: number;
    docsBlocksCount?: number;
}): BenchmarkMetrics {
    const { summary, byCommand, recentCalls } = computeTokenMetrics(
        params.rows,
        params.sessionId,
        params.sessionName,
        params.startedAt,
    );

    const tokenSavings = computeTokenSavings(params.rows, params.docsBlocksCount ?? 0);
    const { drift, samples } = analyzeMemoryDrift(params.rows);

    const resourceTelemetry = {
        enabled: isBenchmarkEnabled(),
        drift,
        samples,
    };

    return {
        summary,
        tokenSavings,
        byCommand,
        recentCalls,
        resourceTelemetry,
    };
}

/**
 * Formats a compact, progressive-disclosure diagnostic report from benchmark metrics.
 * Default output uses <150 tokens. Set focus to 'telemetry' or 'commands' or 'full' for deep drill-down.
 */
export function formatMarkdownReport(
    metrics: BenchmarkMetrics,
    focus: "overview" | "telemetry" | "commands" | "full" = "overview",
): string {
    const s = metrics.summary;
    const sav = metrics.tokenSavings;
    const drift = metrics.resourceTelemetry?.drift;
    const pctSaved = Math.round(
        (sav.estimatedSavedTokens / Math.max(1, s.totalTokens + sav.estimatedSavedTokens)) * 100,
    );

    if (focus === "telemetry" && drift) {
        const lines = [
            `# Runtime Resource & Telemetry Analysis: ${s.sessionName} (${s.sessionId})`,
            `- **Health Status**: \`${drift.health}\``,
            `- **Diagnosis**: ${drift.diagnosis}`,
            "",
            "## Process Footprints",
            `- **Bun Daemon RAM**: Current: ${drift.currentBunRssMb}MB (Peak: ${drift.peakBunRssMb}MB, Baseline: ${drift.initialBunRssMb}MB)`,
            `- **Bun Memory Drift**: ${drift.bunDriftMbPerCall} MB/call`,
            `- **Chrome Extension JS Heap**: Current: ${drift.currentExtHeapMb}MB (Peak: ${drift.peakExtHeapMb}MB)`,
            `- **Extension Drift**: ${drift.extDriftMbPerCall} MB/call`,
            `- **Total Samples**: ${metrics.resourceTelemetry?.samples.length ?? 0}`,
        ];
        return lines.join("\n");
    }

    if (focus === "commands") {
        const lines = [
            `# Command Breakdown: ${s.sessionName} (${s.sessionId})`,
            "| Command | Calls | Avg Tokens | Total Tokens | Avg Duration | Errors |",
            "| :--- | :--- | :--- | :--- | :--- | :--- |",
        ];
        for (const cmd of metrics.byCommand) {
            lines.push(
                `| \`${cmd.cmd}\` | ${cmd.count} | ~${cmd.avgTokens} | ${cmd.totalTokens.toLocaleString()} (${cmd.pctOfTokens}%) | ${cmd.avgDurationMs}ms | ${cmd.errorCount} |`,
            );
        }
        return lines.join("\n");
    }

    // Default overview (Compact, ~150 tokens)
    const lines: string[] = [
        `# Benchmark Summary: ${s.sessionName} (#${s.sessionId.slice(-6)})`,
        `- **Tokens**: ${s.totalTokens.toLocaleString()} total (~${s.avgTokensPerCall} tok/call across ${s.totalCalls} calls)`,
        `- **Saved**: ~${sav.estimatedSavedTokens.toLocaleString()} tok (~${pctSaved}% context saved | Snapshots: ~${sav.savingsBreakdown.fromCompactSnapshots.toLocaleString()} tok, Flow: ~${sav.savingsBreakdown.fromFlowBatching.toLocaleString()} tok, Docs: ~${sav.savingsBreakdown.fromDocsBlocks.toLocaleString()} tok)`,
        `- **Latency & Reliability**: Avg ${s.avgDurationMs}ms/call | ${s.errorRatePct}% errors (${s.errorCount}/${s.totalCalls})`,
    ];

    if (drift && drift.currentBunRssMb > 0) {
        lines.push(
            `- **Health [${drift.health}]**: Bun ${drift.currentBunRssMb}MB (drift ${drift.bunDriftMbPerCall}MB/call) | Ext Heap ${drift.currentExtHeapMb}MB · ${drift.diagnosis}`,
        );
    }

    const topLimit = focus === "full" ? metrics.byCommand.length : 4;
    lines.push("", "### Top Actions");
    for (const cmd of metrics.byCommand.slice(0, topLimit)) {
        lines.push(
            `- \`${cmd.cmd}\` x${cmd.count}: ${cmd.totalTokens.toLocaleString()} tok (${cmd.pctOfTokens}%) · avg ${cmd.avgDurationMs}ms`,
        );
    }

    if (focus === "overview" && metrics.byCommand.length > 4) {
        lines.push(`- *(+${metrics.byCommand.length - 4} more actions; use focus:'commands' to expand)*`);
    }

    return lines.join("\n");
}

export const BenchmarkEngine = {
    isEnabled: isBenchmarkEnabled,
    setEnabled: setBenchmarkEnabled,
    sampleServerMemory,
    computeMetrics,
    formatMarkdownReport,
};

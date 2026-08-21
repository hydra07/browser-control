import {
    DEFAULT_COMPACT_SNAPSHOT_TOKENS,
    DEFAULT_DOCS_BLOCK_TOKENS,
    DEFAULT_FLOW_OVERHEAD_SAVED_PER_STEP,
    DEFAULT_RAW_DOCS_PAGE_TOKENS,
    DEFAULT_RAW_SNAPSHOT_TOKENS,
} from "./constants.js";
import type {
    BenchmarkSummary,
    CommandMetric,
    RawCallRecord,
    RecentCallMetric,
    TokenSavingsBreakdown,
} from "./types.js";

function parseArgsSummary(argsJson: string): string {
    try {
        const parsed = JSON.parse(argsJson);
        if (parsed.text) return `"${String(parsed.text).slice(0, 30)}"`;
        if (parsed.key) return `key: ${parsed.key}`;
        if (parsed.url) return `url: ${String(parsed.url).slice(0, 35)}`;
        if (parsed.nodeId) return `nodeId: ${parsed.nodeId}`;
        if (parsed.query) return `"${parsed.query}"`;
        if (parsed.selector) return `"${parsed.selector}"`;
        if (parsed.action) return parsed.action;
    } catch {}
    return "";
}

/** Calculates summary metrics, command breakdown, and recent calls list from raw records. */
export function computeTokenMetrics(
    rows: RawCallRecord[],
    activeSessionId: string,
    sessionName: string,
    startedAt: number,
): {
    summary: BenchmarkSummary;
    byCommand: CommandMetric[];
    recentCalls: RecentCallMetric[];
} {
    let totalCalls = 0;
    let totalInTokens = 0;
    let totalOutTokens = 0;
    let totalTokens = 0;
    let totalInChars = 0;
    let totalOutChars = 0;
    let totalDurationMs = 0;
    let errorCount = 0;
    let flowStepTotal = 0;

    const commandMap = new Map<
        string,
        {
            count: number;
            inTokens: number;
            outTokens: number;
            totalTokens: number;
            totalDuration: number;
            errorCount: number;
        }
    >();

    const recentCalls: RecentCallMetric[] = [];

    for (const r of rows) {
        totalCalls++;
        const inTok =
            r.in_tokens && r.in_tokens > 0
                ? r.in_tokens
                : Math.max(1, Math.round(((r.args_json?.length ?? 0) + (r.cmd?.length ?? 0)) / 4));
        const outTok =
            r.out_tokens && r.out_tokens > 0
                ? r.out_tokens
                : Math.max(1, r.approx_tokens > inTok ? r.approx_tokens - inTok : r.approx_tokens);
        const inChar = r.in_chars && r.in_chars > 0 ? r.in_chars : (r.args_json?.length ?? 0) + (r.cmd?.length ?? 0);
        const outChar =
            r.out_chars && r.out_chars > 0
                ? r.out_chars
                : r.approx_chars > inChar
                  ? r.approx_chars - inChar
                  : r.approx_chars;

        totalInTokens += inTok;
        totalOutTokens += outTok;
        totalTokens += inTok + outTok;
        totalInChars += inChar;
        totalOutChars += outChar;
        totalDurationMs += r.duration_ms || 0;
        if (r.is_error === 1) errorCount++;
        flowStepTotal += r.step_count || 0;

        const cmdKey = r.cmd || "unknown";
        const entry = commandMap.get(cmdKey) ?? {
            count: 0,
            inTokens: 0,
            outTokens: 0,
            totalTokens: 0,
            totalDuration: 0,
            errorCount: 0,
        };
        entry.count++;
        entry.inTokens += inTok;
        entry.outTokens += outTok;
        entry.totalTokens += inTok + outTok;
        entry.totalDuration += r.duration_ms || 0;
        if (r.is_error === 1) entry.errorCount++;
        commandMap.set(cmdKey, entry);

        recentCalls.push({
            id: r.id,
            cmd: r.cmd,
            durationMs: r.duration_ms,
            inTokens: inTok,
            outTokens: outTok,
            approxTokens: inTok + outTok,
            isError: r.is_error === 1,
            source: r.source,
            preview: r.preview,
            elementRole: r.element_role ?? undefined,
            elementName: r.element_name ?? undefined,
            stepCount: r.step_count ?? 0,
            createdAt: r.created_at,
            argsSummary: parseArgsSummary(r.args_json),
            telemetry:
                r.bun_rss_mb !== undefined
                    ? {
                          timestamp: r.created_at,
                          bunRssMb: r.bun_rss_mb,
                          bunHeapUsedMb: r.bun_heap_used_mb ?? 0,
                          bunHeapTotalMb: r.bun_heap_total_mb ?? 0,
                          extHeapUsedMb: r.ext_heap_used_mb,
                          extHeapTotalMb: r.ext_heap_total_mb,
                          extListeners: r.ext_listeners,
                          extCacheEntries: r.ext_cache_entries,
                          extDurationMs: r.ext_duration_ms,
                      }
                    : undefined,
        });
    }

    const byCommand: CommandMetric[] = Array.from(commandMap.entries()).map(([cmd, data]) => ({
        cmd,
        count: data.count,
        inTokens: data.inTokens,
        outTokens: data.outTokens,
        totalTokens: data.totalTokens,
        avgTokens: data.count > 0 ? Math.round(data.totalTokens / data.count) : 0,
        totalDurationMs: data.totalDuration,
        avgDurationMs: data.count > 0 ? Math.round(data.totalDuration / data.count) : 0,
        errorCount: data.errorCount,
        pctOfTokens: totalTokens > 0 ? Math.round((data.totalTokens / totalTokens) * 100) : 0,
    }));

    byCommand.sort((a, b) => b.totalTokens - a.totalTokens);

    const summary: BenchmarkSummary = {
        sessionId: activeSessionId,
        sessionName,
        startedAt,
        totalCalls,
        totalInTokens,
        totalOutTokens,
        totalTokens,
        totalInChars,
        totalOutChars,
        avgInTokensPerCall: totalCalls > 0 ? Math.round(totalInTokens / totalCalls) : 0,
        avgOutTokensPerCall: totalCalls > 0 ? Math.round(totalOutTokens / totalCalls) : 0,
        avgTokensPerCall: totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0,
        avgDurationMs: totalCalls > 0 ? Math.round(totalDurationMs / totalCalls) : 0,
        totalDurationMs,
        errorCount,
        errorRatePct: totalCalls > 0 ? Math.round((errorCount / totalCalls) * 100) : 0,
        flowStepTotal,
    };

    return { summary, byCommand, recentCalls };
}

/** Computes estimated token savings from architecture optimizations. */
export function computeTokenSavings(rows: RawCallRecord[], docsBlocksCount = 0): TokenSavingsBreakdown {
    let fromFlowBatching = 0;
    let fromCompactSnapshots = 0;
    let fromDocsBlocks = 0;

    for (const r of rows) {
        if (r.cmd === "run_flow" || r.cmd === "explore_flow") {
            const stepCount = r.step_count || 1;
            if (stepCount > 1) {
                fromFlowBatching += (stepCount - 1) * DEFAULT_FLOW_OVERHEAD_SAVED_PER_STEP;
            }
        }
        if (r.cmd === "snapshot") {
            fromCompactSnapshots += Math.max(0, DEFAULT_RAW_SNAPSHOT_TOKENS - DEFAULT_COMPACT_SNAPSHOT_TOKENS);
        }
    }

    if (docsBlocksCount > 0) {
        fromDocsBlocks = docsBlocksCount * (DEFAULT_RAW_DOCS_PAGE_TOKENS - DEFAULT_DOCS_BLOCK_TOKENS);
    }

    const estimatedSavedTokens = fromFlowBatching + fromCompactSnapshots + fromDocsBlocks;

    return {
        estimatedSavedTokens,
        savingsBreakdown: {
            fromFlowBatching,
            fromCompactSnapshots,
            fromDocsBlocks,
        },
    };
}

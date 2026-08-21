import type { ExtensionTelemetry } from "@browsercontrol/shared";

export type { ExtensionTelemetry };

export type HealthClassification = "OPTIMAL" | "STABLE" | "WARNING" | "CRITICAL";

export interface ResourceTelemetrySnapshot {
    timestamp: number;
    bunRssMb: number;
    bunHeapUsedMb: number;
    bunHeapTotalMb: number;
    extHeapUsedMb?: number;
    extHeapTotalMb?: number;
    extListeners?: number;
    extCacheEntries?: number;
    extDurationMs?: number;
}

export interface MemoryDriftAnalysis {
    initialBunRssMb: number;
    peakBunRssMb: number;
    currentBunRssMb: number;
    bunDriftMbPerCall: number;
    initialExtHeapMb: number;
    peakExtHeapMb: number;
    currentExtHeapMb: number;
    extDriftMbPerCall: number;
    health: HealthClassification;
    diagnosis: string;
}

export interface BenchmarkSummary {
    sessionId: string;
    sessionName: string;
    startedAt: number;
    totalCalls: number;
    totalInTokens: number;
    totalOutTokens: number;
    totalTokens: number;
    totalInChars: number;
    totalOutChars: number;
    avgInTokensPerCall: number;
    avgOutTokensPerCall: number;
    avgTokensPerCall: number;
    avgDurationMs: number;
    totalDurationMs: number;
    errorCount: number;
    errorRatePct: number;
    flowStepTotal: number;
}

export interface TokenSavingsBreakdown {
    estimatedSavedTokens: number;
    savingsBreakdown: {
        fromFlowBatching: number;
        fromCompactSnapshots: number;
        fromDocsBlocks: number;
    };
}

export interface CommandMetric {
    cmd: string;
    count: number;
    inTokens: number;
    outTokens: number;
    totalTokens: number;
    avgTokens: number;
    totalDurationMs: number;
    avgDurationMs: number;
    errorCount: number;
    pctOfTokens: number;
}

export interface RecentCallMetric {
    id: number;
    cmd: string;
    durationMs: number;
    inTokens: number;
    outTokens: number;
    approxTokens: number;
    isError: boolean;
    source: string;
    preview: string;
    elementRole?: string;
    elementName?: string;
    stepCount?: number;
    createdAt: number;
    argsSummary: string;
    telemetry?: ResourceTelemetrySnapshot;
}

export interface BenchmarkMetrics {
    summary: BenchmarkSummary;
    tokenSavings: TokenSavingsBreakdown;
    byCommand: CommandMetric[];
    recentCalls: RecentCallMetric[];
    resourceTelemetry?: {
        enabled: boolean;
        drift: MemoryDriftAnalysis;
        samples: ResourceTelemetrySnapshot[];
    };
}

export interface RawCallRecord {
    id: number;
    cmd: string;
    args_json: string;
    duration_ms: number;
    in_chars?: number;
    in_tokens?: number;
    out_chars?: number;
    out_tokens?: number;
    approx_chars: number;
    approx_tokens: number;
    is_error: number;
    source: string;
    preview: string;
    element_role?: string | null;
    element_name?: string | null;
    step_count?: number;
    created_at: number;
    bun_rss_mb?: number;
    bun_heap_used_mb?: number;
    bun_heap_total_mb?: number;
    ext_heap_used_mb?: number;
    ext_heap_total_mb?: number;
    ext_listeners?: number;
    ext_cache_entries?: number;
    ext_duration_ms?: number;
}

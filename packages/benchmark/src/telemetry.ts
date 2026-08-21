import {
    DRIFT_OPTIMAL_THRESHOLD_MB_PER_CALL,
    DRIFT_STABLE_THRESHOLD_MB_PER_CALL,
    DRIFT_WARNING_THRESHOLD_MB_PER_CALL,
} from "./constants.js";
import type { HealthClassification, MemoryDriftAnalysis, RawCallRecord, ResourceTelemetrySnapshot } from "./types.js";

/** Analyzes time-series memory telemetry and classifies stability health. */
export function analyzeMemoryDrift(rows: RawCallRecord[]): {
    drift: MemoryDriftAnalysis;
    samples: ResourceTelemetrySnapshot[];
} {
    const validSamples: ResourceTelemetrySnapshot[] = [];

    for (const r of rows) {
        if (r.bun_rss_mb !== undefined && r.bun_rss_mb > 0) {
            validSamples.push({
                timestamp: r.created_at,
                bunRssMb: r.bun_rss_mb,
                bunHeapUsedMb: r.bun_heap_used_mb ?? 0,
                bunHeapTotalMb: r.bun_heap_total_mb ?? 0,
                extHeapUsedMb: r.ext_heap_used_mb,
                extHeapTotalMb: r.ext_heap_total_mb,
                extListeners: r.ext_listeners,
                extCacheEntries: r.ext_cache_entries,
                extDurationMs: r.ext_duration_ms,
            });
        }
    }

    // Sort ascending by time
    validSamples.sort((a, b) => a.timestamp - b.timestamp);

    if (validSamples.length === 0) {
        return {
            drift: {
                initialBunRssMb: 0,
                peakBunRssMb: 0,
                currentBunRssMb: 0,
                bunDriftMbPerCall: 0,
                initialExtHeapMb: 0,
                peakExtHeapMb: 0,
                currentExtHeapMb: 0,
                extDriftMbPerCall: 0,
                health: "OPTIMAL",
                diagnosis: "No telemetry samples recorded for this session yet.",
            },
            samples: [],
        };
    }

    const first = validSamples[0];
    const last = validSamples[validSamples.length - 1];
    if (!first || !last) {
        return {
            drift: {
                initialBunRssMb: 0,
                peakBunRssMb: 0,
                currentBunRssMb: 0,
                bunDriftMbPerCall: 0,
                initialExtHeapMb: 0,
                peakExtHeapMb: 0,
                currentExtHeapMb: 0,
                extDriftMbPerCall: 0,
                health: "OPTIMAL",
                diagnosis: "No telemetry samples recorded for this session yet.",
            },
            samples: [],
        };
    }

    const count = validSamples.length;
    let peakBunRss = 0;
    let peakExtHeap = 0;

    for (const s of validSamples) {
        if (s.bunRssMb > peakBunRss) peakBunRss = s.bunRssMb;
        if ((s.extHeapUsedMb ?? 0) > peakExtHeap) peakExtHeap = s.extHeapUsedMb ?? 0;
    }

    const callsDiff = Math.max(1, count - 1);
    const bunDrift = count > 1 ? Number(((last.bunRssMb - first.bunRssMb) / callsDiff).toFixed(3)) : 0;
    const extDrift =
        count > 1 && last.extHeapUsedMb !== undefined && first.extHeapUsedMb !== undefined
            ? Number(((last.extHeapUsedMb - first.extHeapUsedMb) / callsDiff).toFixed(3))
            : 0;

    let health: HealthClassification = "OPTIMAL";
    let diagnosis = "Memory profile is flatline optimal with zero drift detected.";

    const maxDrift = Math.max(bunDrift, extDrift);

    if (maxDrift > DRIFT_WARNING_THRESHOLD_MB_PER_CALL) {
        health = "CRITICAL";
        diagnosis = `Significant continuous memory growth (${maxDrift.toFixed(2)} MB/call). Potential leak in listeners or buffers.`;
    } else if (maxDrift > DRIFT_STABLE_THRESHOLD_MB_PER_CALL) {
        health = "WARNING";
        diagnosis = `Moderate memory climb (${maxDrift.toFixed(2)} MB/call). Monitor GC cycles and buffer limits.`;
    } else if (maxDrift > DRIFT_OPTIMAL_THRESHOLD_MB_PER_CALL) {
        health = "STABLE";
        diagnosis = `Minor memory drift (${maxDrift.toFixed(2)} MB/call) within normal GC fluctuations.`;
    }

    return {
        drift: {
            initialBunRssMb: first.bunRssMb,
            peakBunRssMb: peakBunRss,
            currentBunRssMb: last.bunRssMb,
            bunDriftMbPerCall: bunDrift,
            initialExtHeapMb: first.extHeapUsedMb ?? 0,
            peakExtHeapMb: peakExtHeap,
            currentExtHeapMb: last.extHeapUsedMb ?? 0,
            extDriftMbPerCall: extDrift,
            health,
            diagnosis,
        },
        samples: validSamples,
    };
}

export interface MemoryMetricsReport {
    summary: {
        jsHeapUsedMb: number;
        jsHeapTotalMb: number;
        jsHeapPercent: number;
        domNodes: number;
        documents: number;
        jsEventListeners: number;
        gcPressure: "low" | "moderate" | "high";
    };
    details?: Record<string, unknown>;
}

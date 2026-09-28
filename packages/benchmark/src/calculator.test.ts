import { describe, expect, test } from "bun:test";
import { computeTokenMetrics, computeTokenSavings } from "./calculator.js";
import type { RawCallRecord } from "./types.js";

function call(overrides: Partial<RawCallRecord> = {}): RawCallRecord {
    return {
        id: 1,
        cmd: "snapshot",
        args_json: '{"compact":true}',
        duration_ms: 100,
        in_chars: 40,
        in_tokens: 10,
        out_chars: 80,
        out_tokens: 20,
        approx_chars: 120,
        approx_tokens: 30,
        is_error: 0,
        source: "mcp",
        preview: "snapshot",
        step_count: 0,
        created_at: 1,
        ...overrides,
    };
}

describe("benchmark calculator", () => {
    test("aggregates character, token, duration, and error metrics per command", () => {
        const metrics = computeTokenMetrics(
            [call(), call({ id: 2, cmd: "run_flow", step_count: 3, duration_ms: 300, is_error: 1 })],
            "session-1",
            "Smoke Test",
            1,
        );

        expect(metrics.summary).toMatchObject({
            sessionId: "session-1",
            totalCalls: 2,
            totalInTokens: 20,
            totalOutTokens: 40,
            totalTokens: 60,
            totalInChars: 80,
            totalOutChars: 160,
            totalDurationMs: 400,
            errorCount: 1,
            flowStepTotal: 3,
        });
        expect(metrics.byCommand[0]).toMatchObject({ cmd: "snapshot", count: 1, totalTokens: 30 });
        expect(metrics.byCommand[1]).toMatchObject({ cmd: "run_flow", count: 1, errorCount: 1 });
    });

    test("names the heuristic savings baseline for flow, snapshot, and docs blocks", () => {
        const savings = computeTokenSavings([call(), call({ id: 2, cmd: "run_flow", step_count: 3 })], 2);

        expect(savings.savingsBreakdown).toEqual({
            fromFlowBatching: 500,
            fromCompactSnapshots: 2800,
            fromDocsBlocks: 5400,
        });
        expect(savings.estimatedSavedTokens).toBe(8700);
    });

    test("keeps an empty metrics report at zero", () => {
        const metrics = computeTokenMetrics([], "empty-session", "Empty", 0);

        expect(metrics.summary).toMatchObject({
            totalCalls: 0,
            totalTokens: 0,
            totalDurationMs: 0,
            errorCount: 0,
        });
    });
});

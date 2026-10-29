import { describe, expect, test } from "bun:test";
import { type ActionResult, isActionResult } from "./actionResult.js";

const completed = {
    actionId: "a_fixture",
    kind: "click",
    status: "completed",
    dispatched: true,
    inputState: "acknowledged",
    acknowledged: true,
    cleanupComplete: true,
    startedAt: 1000,
    dispatchedAt: 1001,
    finishedAt: 1002,
    bbox: null,
    verified: false,
    observation: "not_observed",
} satisfies ActionResult;

describe("direct action result", () => {
    test("accepts direct navigation/tab/scroll acknowledgements without implying verification", () => {
        for (const kind of ["navigate", "create_tab", "close_tab", "scroll"] as const) {
            expect(isActionResult({ ...completed, kind })).toBe(true);
            expect(isActionResult({ ...completed, kind, verified: true })).toBe(false);
        }
    });
    test("matches the Go wire fixtures", async () => {
        const data: unknown = await Bun.file(new URL("../testdata/action-results.json", import.meta.url)).json();
        if (!Array.isArray(data)) throw new Error("expected fixture array");
        const fixtures: unknown[] = data;
        for (const fixture of fixtures) {
            if (typeof fixture !== "object" || fixture === null || !("valid" in fixture) || !("result" in fixture))
                throw new Error("invalid fixture");
            if (typeof fixture.valid !== "boolean") throw new Error("invalid fixture expectation");
            expect(isActionResult(fixture.result)).toBe(fixture.valid);
        }
    });
    test("does not turn an acknowledged input into UI verification", () => {
        expect(isActionResult(completed)).toBe(true);
        expect(isActionResult({ ...completed, verified: true })).toBe(false);
        expect(isActionResult({ ...completed, dispatched: false })).toBe(false);
        expect(isActionResult({ ...completed, acknowledged: false })).toBe(false);
        expect(isActionResult({ ...completed, dispatchedAt: null })).toBe(false);
    });
    test("accepts unknown and pre-dispatch cancellation without false completion", () => {
        expect(
            isActionResult({
                ...completed,
                status: "outcome_unknown",
                inputState: "write_attempted",
                acknowledged: false,
            }),
        ).toBe(true);
        expect(
            isActionResult({
                ...completed,
                status: "cancelled",
                dispatched: false,
                inputState: "not_sent",
                acknowledged: false,
                dispatchedAt: null,
            }),
        ).toBe(true);
        expect(isActionResult({ ...completed, finishedAt: 999 })).toBe(false);
        expect(isActionResult({ ...completed, bbox: { x: 0, y: 0, width: -1, height: 1 } })).toBe(false);
    });
});

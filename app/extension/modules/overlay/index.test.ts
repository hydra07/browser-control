import { describe, expect, test } from "bun:test";
import type { ActionLifecycleEvent } from "@browsercontrol/shared";
import { getActionFeedback } from "./index.js";

function finished(
    overrides: Partial<Extract<ActionLifecycleEvent, { type: "action_finished" }>> = {},
): ActionLifecycleEvent {
    return {
        type: "action_finished",
        actionId: "a1",
        ts: 200,
        action: "click",
        durationMs: 100,
        result: "succeeded",
        drift: "EXACT",
        sensitive: false,
        ...overrides,
    };
}

describe("action overlay feedback", () => {
    test("keeps progress feedback short and target-private", () => {
        const feedback = getActionFeedback({
            type: "action_started",
            actionId: "a1",
            ts: 100,
            action: "click",
            tabId: 7,
            targetRef: "e99",
            semanticTarget: { role: "button", name: "Private account action" },
            sensitive: true,
        });

        expect(feedback.text).toBe("Click in progress");
        expect(feedback.text).not.toContain("Private account action");
        expect(feedback.durationMs).toBe(30_000);
        expect(feedback.fast).toBe(true);
    });

    test("distinguishes exact success from repair and drift", () => {
        expect(getActionFeedback(finished()).text).toBe("Click complete");
        expect(getActionFeedback(finished({ drift: "SEMANTIC_REPAIR" })).text).toBe("Repaired · Click");
        expect(getActionFeedback(finished({ drift: "TARGET_DRIFT" })).text).toBe("Target changed · Click");
        expect(getActionFeedback(finished({ drift: "BEHAVIOR_DRIFT" })).text).toBe("Behavior changed · Click");
    });

    test("uses explicit confirmation and failure states", () => {
        const blocked = getActionFeedback(finished({ result: "blocked" }));
        const failed = getActionFeedback(finished({ result: "failed" }));

        expect(blocked.text).toBe("Click needs confirmation");
        expect(blocked.color).toBe("#fcd34d");
        expect(failed.text).toBe("Click failed");
        expect(failed.color).toBe("#fca5a5");
    });
});

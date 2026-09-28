import { describe, expect, test } from "bun:test";
import type { ActionLifecycleEvent } from "@browsercontrol/shared";
import { emitActionLifecycle, subscribeActionLifecycle } from "./events.js";

describe("action lifecycle events", () => {
    test("delivers immutable start and finish events until disposed", () => {
        const received: ActionLifecycleEvent[] = [];
        const dispose = subscribeActionLifecycle((event) => received.push(event));
        const started = {
            type: "action_started",
            actionId: "a1",
            ts: 100,
            action: "click",
            sensitive: false,
        } satisfies ActionLifecycleEvent;
        const finished = {
            type: "action_finished",
            actionId: "a1",
            ts: 125,
            action: "click",
            durationMs: 25,
            result: "succeeded",
            drift: "EXACT",
            sensitive: false,
        } satisfies ActionLifecycleEvent;

        emitActionLifecycle(started);
        emitActionLifecycle(finished);
        dispose();
        emitActionLifecycle({ ...finished, actionId: "a2" });

        expect(received).toEqual([started, finished]);
    });
});

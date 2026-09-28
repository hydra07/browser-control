import { describe, expect, test } from "bun:test";
import type { ActionLifecycleEvent, FailureEvent } from "@browsercontrol/shared";
import {
    EvidenceTimelineStore,
    emitAssertionEvent,
    emitFailureEvent,
    installActionLifecycleEvidence,
} from "./index.js";

describe("EvidenceTimelineStore", () => {
    test("keeps the model-facing overview bounded while retaining counts", () => {
        const store = new EvidenceTimelineStore(2);
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
            sensitive: false,
        } satisfies ActionLifecycleEvent;
        const failure = {
            type: "failure",
            id: "f1",
            timestamp: 130,
            phase: "assert",
            code: "behavior_drift",
            message: "A failure message that is deliberately longer than the small storage boundary.",
        } satisfies FailureEvent;

        store.append(started);
        store.append(finished);
        store.append(failure);

        const overview = store.overview("session-1", "failure");
        expect(overview.counts).toEqual({ actions: 1, assertions: 0, failures: 1, artifacts: 0 });
        expect(overview.primaryFailureRef).toBe("f1");
        expect(overview.droppedEvents).toBe(1);
        expect(overview).not.toHaveProperty("events");
        expect(store.eventsAfter(0, 100)).toHaveLength(2);
        expect(store.eventsAfter(0, 100)[1]).toMatchObject({ message: expect.stringContaining("failure message") });
    });

    test("routes assertion and failure events through the same bounded track", () => {
        const store = new EvidenceTimelineStore(4);
        const dispose = installActionLifecycleEvidence(store);

        emitAssertionEvent({ expression: "status contains ready", result: "passed", sensitive: false });
        emitFailureEvent({ phase: "settle", code: "timeout", message: "The page kept mutating." });

        expect(store.overview("session-3", "failure").counts).toEqual({
            actions: 0,
            assertions: 1,
            failures: 1,
            artifacts: 0,
        });
        expect(store.eventsAfter(0, 10)).toHaveLength(2);
        dispose();
    });

    test("clamps event queries and resets counters", () => {
        const store = new EvidenceTimelineStore(4);
        store.addArtifact();
        store.clear();

        expect(store.overview("session-2", "none").counts).toEqual({
            actions: 0,
            assertions: 0,
            failures: 0,
            artifacts: 0,
        });
        expect(store.eventsAfter(-10, 0)).toEqual([]);
    });

    test("clears a restored timeline when the daemon session changes", () => {
        const store = new EvidenceTimelineStore(4);
        store.activateSession("session-a");
        store.append({
            type: "failure",
            id: "f-old",
            timestamp: 100,
            phase: "action",
            code: "old_session",
            message: "old session event",
        });
        store.activateSession("session-b");

        expect(store.overview("session-b", "flow").counts.failures).toBe(0);
        expect(store.eventsAfter(0, 4)).toEqual([]);
    });

    test("hydrates bounded state and removes sensitive target details", () => {
        const store = new EvidenceTimelineStore(4);
        store.append({
            type: "action_started",
            actionId: "a-secret",
            ts: 100,
            action: "type",
            targetRef: "e17",
            semanticTarget: { role: "textbox", name: "Password", inputName: "password" },
            sensitive: true,
        });
        store.append({
            type: "action_finished",
            actionId: "a-secret",
            ts: 110,
            action: "type",
            targetRef: "e17",
            durationMs: 10,
            result: "succeeded",
            sensitive: true,
        });

        const restored = new EvidenceTimelineStore(4);
        expect(restored.hydrate(store.serialize())).toBe(true);
        expect(restored.overview("session-4", "flow").counts.actions).toBe(1);
        expect(restored.eventsAfter(0, 4)[0]).toMatchObject({
            type: "action_started",
            targetRef: undefined,
            semanticTarget: undefined,
        });
    });
});

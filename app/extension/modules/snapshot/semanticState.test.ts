import { describe, expect, test } from "bun:test";
import type { DocumentScope } from "@browsercontrol/shared";
import { type SemanticCandidate, SemanticState } from "./semanticState.js";

function candidate(backendNodeId: number, structuralKey: string, parentStructuralKey?: string): SemanticCandidate {
    return {
        role: "button",
        name: "Save",
        backendNodeId,
        structuralKey,
        ...(parentStructuralKey ? { parentStructuralKey } : {}),
    };
}

function createState(options: Partial<ConstructorParameters<typeof SemanticState>[0]> = {}): SemanticState {
    return new SemanticState({
        tabId: 7,
        frameId: "main",
        documentId: "doc-a",
        loaderId: "loader-a",
        ...options,
    });
}

function scopeWith(scope: DocumentScope, patch: Partial<DocumentScope>): DocumentScope {
    return { ...scope, ...patch };
}

describe("SemanticState", () => {
    test("preserves a ref when a same-document rerender changes its backend node id", () => {
        const state = createState();
        const first = state.update({}, [candidate(101, "form/save")]);
        const firstRef = first.snapshot.nodes[0]?.ref ?? "";

        const second = state.update({ loaderId: "loader-a" }, [candidate(202, "form/save")]);
        const secondRef = second.snapshot.nodes[0]?.ref ?? "";

        expect(firstRef).toBe("e1");
        expect(secondRef).toBe(firstRef);
        expect(second.delta.fromRevision).toBe("r1");
        expect(second.delta.changed).toEqual([]);
        expect(second.delta.added).toEqual([]);
        expect(second.delta.removed).toEqual([]);
        expect(state.resolve(firstRef, second.snapshot.scope)?.backendNodeId).toBe(202);
    });

    test("does not invalidate refs when only the semantic revision changes", () => {
        const state = createState();
        const first = state.update({}, [candidate(101, "form/save")]);
        const ref = first.snapshot.nodes[0]?.ref ?? "";

        state.update({}, [candidate(101, "form/save")]);

        expect(state.getRevision()).toBe("r2");
        expect(state.getRef(ref)?.status).toBe("active");
        expect(state.resolve(ref, first.snapshot.scope)?.backendNodeId).toBe(101);
    });

    test("invalidates the old scope when a loader replaces the document", () => {
        let nextDocument = 0;
        const state = createState({
            documentIdFactory: () => `doc-${++nextDocument}`,
        });
        const first = state.update({}, [candidate(101, "form/save")]);
        const ref = first.snapshot.nodes[0]?.ref ?? "";

        const second = state.update({ loaderId: "loader-b" }, [candidate(303, "form/save")]);

        expect(second.snapshot.scope.documentId).toBe("doc-1");
        expect(second.delta.fromRevision).toBeUndefined();
        expect(state.resolve(ref, first.snapshot.scope)).toBeNull();
        expect(state.resolve(ref, second.snapshot.scope)?.backendNodeId).toBe(303);
    });

    test("rejects a ref when tab, frame, or document scope does not match", () => {
        const state = createState();
        const first = state.update({}, [candidate(101, "form/save")]);
        const ref = first.snapshot.nodes[0]?.ref ?? "";

        expect(state.resolve(ref, scopeWith(first.snapshot.scope, { tabId: 8 }))).toBeNull();
        expect(state.resolve(ref, scopeWith(first.snapshot.scope, { frameId: "frame-2" }))).toBeNull();
        expect(state.resolve(ref, scopeWith(first.snapshot.scope, { loaderId: "loader-other" }))).toBeNull();
        expect(state.resolve(ref, scopeWith(first.snapshot.scope, { documentId: "doc-other" }))).toBeNull();
    });

    test("marks duplicate structural identities uncertain instead of selecting one", () => {
        const state = createState();
        const update = state.update({}, [candidate(101, "form/save"), candidate(102, "form/save")]);
        const refs = update.snapshot.nodes.map((node) => node.ref);

        expect(refs).toEqual(["e1", "e2"]);
        expect(update.snapshot.identityUncertainty).toBe(true);
        expect(update.delta.uncertainRefs).toEqual(refs);
        expect(state.resolve(refs[0] ?? "", update.snapshot.scope)).toBeNull();
        expect(state.resolve(refs[1] ?? "", update.snapshot.scope)).toBeNull();
    });

    test("keeps same-name nodes distinct in collision-safe deltas", () => {
        const state = createState();
        const first = state.update({}, [candidate(101, "form/primary"), candidate(102, "form/secondary")]);
        const second = state.update({}, [{ ...candidate(202, "form/secondary"), value: "updated" }]);

        expect(first.snapshot.nodes.map((node) => node.ref)).toEqual(["e1", "e2"]);
        expect(second.snapshot.nodes.map((node) => node.ref)).toEqual(["e2"]);
        expect(second.delta.removed).toEqual(["e1"]);
        expect(second.delta.changed.map((node) => node.ref)).toEqual(["e2"]);
    });

    test("bounds snapshots and deltas", () => {
        const state = createState({ maxNodes: 150 });
        const candidates = Array.from({ length: 105 }, (_, index) => candidate(index + 1, `row/${index}`));
        const first = state.update({}, candidates);
        const second = state.update({}, []);

        expect(first.snapshot.nodes).toHaveLength(105);
        expect(second.delta.removed).toHaveLength(100);
        expect(second.delta.truncated).toBe(true);
    });

    test("marks source snapshots truncated at the configured node limit", () => {
        const state = createState({ maxNodes: 2 });
        const update = state.update({}, [candidate(1, "row/1"), candidate(2, "row/2"), candidate(3, "row/3")]);

        expect(update.snapshot.nodes).toHaveLength(2);
        expect(update.snapshot.truncated).toBe(true);
        expect(update.delta.truncated).toBe(true);
    });
});

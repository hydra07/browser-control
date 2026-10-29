import { describe, expect, test } from "bun:test";
import type { Protocol } from "devtools-protocol";
import reordered from "../../../../fixtures/synthetic/sequences/action-insert-reorder.json";
import replacement from "../../../../fixtures/synthetic/sequences/action-replacement.json";
import virtualized from "../../../../fixtures/synthetic/sequences/action-virtualized.json";
import { fixtureAX, identityTarget, observeIdentity, retainedIdentity } from "./identityFixtures/index.js";
import type { IdentityFixtureState } from "./identityFixtures/types.js";
import { SemanticState } from "./semanticState.js";

/** Expected failures execute in ordinary CI and become failures themselves once the contract passes. */
const knownFailure = Bun.env.BROWSERCONTROL_IDENTITY_STRICT === "1" ? test : test.failing;

function createState(input: IdentityFixtureState): SemanticState {
    return new SemanticState({ tabId: 7, frameId: "main", loaderId: "loader-a", documentId: input.document });
}

function findAX(nodes: Protocol.Accessibility.AXNode[], handle: number): Protocol.Accessibility.AXNode {
    const node = nodes.find((node) => node.backendDOMNodeId === handle);
    if (!node) throw new Error(`Missing AX handle ${handle}`);
    return node;
}

function renameAX(node: Protocol.Accessibility.AXNode, name: string): void {
    node.name = { type: "computedString", value: name };
}

describe("R0-03 identity contract", () => {
    const initial = reordered.states[0];
    const saveHandle = initial.nodes.find((node) => node.key === "save")?.handle;
    if (!saveHandle) throw new Error("Missing Save witness");

    const unchangedState = createState(initial);
    const unchangedBefore = observeIdentity(unchangedState, initial);
    const unchangedAfter = observeIdentity(unchangedState, initial, fixtureAX(initial), {}, { title: "Updated title" });

    const titleState = createState(initial);
    const titleBefore = observeIdentity(titleState, initial);
    const titleNodes = fixtureAX(initial);
    const root = titleNodes.find((node) => node.role?.value === "RootWebArea");
    if (!root) throw new Error("Missing document AX root");
    renameAX(root, "Updated title");
    const titleAfter = observeIdentity(titleState, initial, titleNodes, {}, { title: "Updated title" });

    const ancestorState = createState(initial);
    const ancestorNodes = fixtureAX(initial);
    const save = findAX(ancestorNodes, saveHandle);
    const ancestor = ancestorNodes.find((node) => node.nodeId === save.parentId);
    if (!ancestor) throw new Error("Missing Save ancestor");
    ancestor.role = { type: "role", value: "group" };
    renameAX(ancestor, "Customer details");
    const ancestorBefore = observeIdentity(ancestorState, initial, ancestorNodes);
    renameAX(ancestor, "Customer account");
    const ancestorAfter = observeIdentity(ancestorState, initial, ancestorNodes);

    const labelState = createState(initial);
    const labelBefore = observeIdentity(labelState, initial);
    const labelNodes = fixtureAX(initial);
    renameAX(findAX(labelNodes, saveHandle), "Save changes");
    const labelAfter = observeIdentity(labelState, initial, labelNodes);

    const reorderState = createState(initial);
    const reorderBefore = observeIdentity(reorderState, initial);
    const inserted = observeIdentity(reorderState, reordered.states[1]);
    const reorderAfter = observeIdentity(reorderState, reordered.states[2]);
    const rowKeys = ["row-slot-0-action", "row-slot-1-action"];

    const replacementState = createState(replacement.states[0]);
    const replacementBefore = observeIdentity(replacementState, replacement.states[0]);
    const replacementAfter = observeIdentity(replacementState, replacement.states[1]);
    const oldTarget = identityTarget(replacementBefore, "replace-target");
    const newTarget = identityTarget(replacementAfter, "replace-target");

    const virtualState = createState(virtualized.states[0]);
    const virtualBefore = observeIdentity(virtualState, virtualized.states[0]);
    const virtualAfter = observeIdentity(virtualState, virtualized.states[1]);
    const virtualReturn = observeIdentity(virtualState, virtualized.states[2]);

    /** Fixture/adapter errors must escape before the expected-failure wrappers can catch them. */
    const titleRetained = retainedIdentity(titleBefore, titleAfter, "save");
    const ancestorRetained = retainedIdentity(ancestorBefore, ancestorAfter, "save");
    const labelRetained = retainedIdentity(labelBefore, labelAfter, "save");
    const rowsRetained = rowKeys.map((key) => retainedIdentity(inserted, reorderAfter, key));
    const replacementIdentity = {
        freshRef: newTarget.node.ref !== oldTarget.node.ref,
        oldRefStale: !replacementAfter.resolved.has(oldTarget.node.ref),
    };

    test("metadata-only title updates retain refs (collector integration is exercised separately)", () => {
        expect(unchangedAfter.update.snapshot.title).toBe("Updated title");
        for (const { key } of initial.nodes) expect(retainedIdentity(unchangedBefore, unchangedAfter, key)).toBe(true);
    });

    test("fixture witnesses distinguish replacement, reorder and virtual reuse independently of engine refs", () => {
        expect(oldTarget.physical).not.toBe(newTarget.physical);
        expect(oldTarget.handle).not.toBe(newTarget.handle);
        expect(replacement.states[0].document).toBe(replacement.states[1].document);
        for (const key of rowKeys) {
            const before = identityTarget(reorderBefore, key);
            const after = identityTarget(reorderAfter, key);
            expect(after.physical).toBe(before.physical);
            expect(after.handle).toBe(before.handle);
            expect(after.anchor).toBe(before.anchor);
        }
        const row = identityTarget(virtualAfter, rowKeys[0]);
        expect(row.physical).toBe(identityTarget(virtualBefore, rowKeys[0]).physical);
        expect(row.anchor).not.toBe(identityTarget(virtualBefore, rowKeys[0]).anchor);
        expect(
            virtualized.transitions[0].expected.mappings.find((mapping) => mapping.key === rowKeys[0])?.anchorGuard,
        ).toBe("stale_fingerprint");
    });

    test("inserting an unrelated sibling retains all witnessed controls", () => {
        for (const { key } of initial.nodes) expect(retainedIdentity(reorderBefore, inserted, key)).toBe(true);
    });

    test("inserting an identical sibling keeps the existing physical ref and does not guess a new target", () => {
        const state = createState(initial);
        const before = observeIdentity(state, initial);
        const nodes = fixtureAX(initial);
        const original = findAX(nodes, saveHandle);
        const parent = nodes.find((node) => node.nodeId === original.parentId);
        if (!parent?.childIds) throw new Error("Missing sibling insertion point");
        const freshHandle = Math.max(...nodes.map((node) => node.backendDOMNodeId ?? 0)) + 1;
        const duplicate = { ...original, nodeId: "r0-03-duplicate", backendDOMNodeId: freshHandle, childIds: [] };
        parent.childIds.splice(parent.childIds.indexOf(original.nodeId), 0, duplicate.nodeId);
        nodes.push(duplicate);
        const after = observeIdentity(state, initial, nodes);
        const previousRef = identityTarget(before, "save").node.ref;
        expect(retainedIdentity(before, after, "save")).toBe(true);
        const matching = after.update.snapshot.nodes.filter(
            (node) => node.role === "button" && node.name === original.name?.value,
        );
        expect(matching).toHaveLength(2);
        expect(new Set(matching.map((node) => node.ref)).size).toBe(2);
        const fresh = matching.find((node) => node.ref !== previousRef);
        expect(fresh?.identityUncertain).toBe(true);
        expect(after.resolved.has(fresh?.ref ?? "")).toBe(false);
    });

    test("duplicate controls have separate refs and never resolve to each other's handle in one revision", () => {
        const targets = rowKeys.map((key) => identityTarget(reorderBefore, key));
        expect(new Set(targets.map((target) => target.node.ref)).size).toBe(2);
        for (const target of targets) {
            if (target.node.identityUncertain) expect(reorderBefore.resolved.has(target.node.ref)).toBe(false);
            else expect(reorderBefore.resolved.get(target.node.ref)).toBe(target.handle);
        }
    });

    test("virtualized slot keeps physical identity across both windows; business anchor drift is separate", () => {
        expect(retainedIdentity(virtualBefore, virtualAfter, rowKeys[0])).toBe(true);
        expect(retainedIdentity(virtualBefore, virtualReturn, rowKeys[0])).toBe(true);
        expect(identityTarget(virtualReturn, rowKeys[0]).anchor).toBe(identityTarget(virtualBefore, rowKeys[0]).anchor);
    });

    test("a new document rejects old scoped refs even if backend handles and labels repeat", () => {
        const state = createState(initial);
        const before = observeIdentity(state, initial);
        const previous = identityTarget(before, "save");
        const after = observeIdentity(state, initial, fixtureAX(initial), { loaderId: "loader-b" });
        expect(after.update.snapshot.scope.documentId).not.toBe(before.update.snapshot.scope.documentId);
        expect(state.resolve(previous.node.ref, before.update.snapshot.scope)).toBeNull();
        expect(() => retainedIdentity(before, after, "save")).toThrow("same document scope");
    });

    knownFailure("title changes in the AX root retain the same physical control ref", () => {
        expect(titleRetained).toBe(true);
    });

    knownFailure("renaming a named ancestor retains the same physical control ref", () => {
        expect(ancestorRetained).toBe(true);
    });

    knownFailure("renaming a control retains its physical ref", () => {
        expect(labelRetained).toBe(true);
    });

    knownFailure("reordering identical controls across rows never swaps refs", () => {
        expect(rowsRetained).toEqual([true, true]);
    });

    knownFailure("a known physical replacement cannot silently take over the old executable ref", () => {
        expect(replacementIdentity).toEqual({ freshRef: true, oldRefStale: true });
    });
});

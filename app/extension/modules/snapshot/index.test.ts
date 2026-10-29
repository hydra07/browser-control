import { describe, expect, test } from "bun:test";
import type { Protocol } from "devtools-protocol";
import { buildRegionTree, buildSemanticCandidates, buildSnapshotNodes, formatCompactSnapshot } from "./index.js";

function axNode(input: Partial<Protocol.Accessibility.AXNode> & { nodeId: string }): Protocol.Accessibility.AXNode {
    return input as Protocol.Accessibility.AXNode;
}

describe("snapshot transformations", () => {
    test("normalizes multiline semantic names before bounding them", () => {
        const node = axNode({
            nodeId: "button",
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "  Sign\n\t in    now  " },
            backendDOMNodeId: 7,
        });
        expect(buildSemanticCandidates([node])[0]?.name).toBe("Sign in now");
    });

    test("keeps actionable nodes and removes redundant text children", () => {
        const nodes = [
            axNode({
                nodeId: "button",
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Save" },
                backendDOMNodeId: 7,
                childIds: ["label"],
            }),
            axNode({
                nodeId: "label",
                role: { type: "role", value: "StaticText" },
                name: { type: "computedString", value: "Save" },
            }),
        ];

        expect(buildSnapshotNodes(nodes)).toEqual([{ i: 7, r: "button", n: "Save" }]);
        expect(formatCompactSnapshot(buildSnapshotNodes(nodes))).toBe('[7] button "Save"');
    });

    test("collapses per-glyph text runs, restoring spaces at backend id gaps", () => {
        const text = (id: number, value: string) =>
            axNode({
                nodeId: `t${id}`,
                role: { type: "role", value: "StaticText" },
                name: { type: "computedString", value },
                backendDOMNodeId: id,
            });
        const nodes = [
            text(10, "H"),
            text(11, "i"),
            text(13, "y"),
            text(14, "o"),
            axNode({
                nodeId: "link",
                role: { type: "role", value: "link" },
                name: { type: "computedString", value: "More" },
                backendDOMNodeId: 20,
            }),
            text(30, "tail"),
        ];

        expect(buildSnapshotNodes(nodes)).toEqual([
            { i: 10, r: "StaticText", n: "Hi yo" },
            { i: 20, r: "link", n: "More" },
            { i: 30, r: "StaticText", n: "tail" },
        ]);
    });

    test("builds a nested region tree and reports an empty root safely", () => {
        const nodes = [
            axNode({ nodeId: "root", role: { type: "role", value: "generic" }, childIds: ["heading"] }),
            axNode({
                nodeId: "heading",
                role: { type: "role", value: "heading" },
                name: { type: "computedString", value: "Details" },
                backendDOMNodeId: 8,
            }),
        ];
        expect(buildRegionTree(nodes)).toEqual({ tree: [{ i: 8, r: "heading", n: "Details" }], truncated: false });
        expect(buildRegionTree([])).toEqual({ tree: [], truncated: false });
    });

    test("assigns structural identities without carrying input values into semantic state", () => {
        const nodes = [
            axNode({ nodeId: "root", role: { type: "role", value: "generic" }, childIds: ["save-a", "save-b"] }),
            axNode({
                nodeId: "save-a",
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Save" },
                value: { type: "computedString", value: "secret-value" },
                backendDOMNodeId: 11,
            }),
            axNode({
                nodeId: "save-b",
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Save" },
                backendDOMNodeId: 12,
            }),
        ];

        const candidates = buildSemanticCandidates(nodes);
        expect(candidates).toHaveLength(2);
        expect(candidates[0]?.structuralKey).not.toBe(candidates[1]?.structuralKey);
        expect(candidates[0]?.value).toBeUndefined();
        expect(candidates[0]?.name).toBe("Save");
    });
});

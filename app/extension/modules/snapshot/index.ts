/**
 * Accessibility-tree snapshot builder generating compact {i, r, n, v} node lists.
 */
import type { Protocol } from "devtools-protocol";
import { quadToBox, sendCommand } from "../../libs/cdp.js";
import { captureAnnotatedScreenshot } from "../screenshot/index.js";
import { INTERACTIVE_ROLES, MAX_ANNOTATED, MAX_REGION_NODES } from "./constants.js";
import type { SnapshotEntry } from "./types.js";

export type { SnapshotEntry } from "./types.js";

type AXNode = Protocol.Accessibility.AXNode;

/** Interactive roles only count if they resolve to a real DOM node (otherwise click/type would get an unusable id); text-ish roles only count if they have text. */
function isMeaningfulAxNode(node: AXNode): boolean {
    const role = node.role?.value;
    if (!role) return false;
    if (INTERACTIVE_ROLES.has(role)) return !!node.backendDOMNodeId;
    if (role === "StaticText" || role === "heading" || role === "paragraph") {
        const text = node.name?.value?.trim();
        return !!text && text.length > 0;
    }
    return false;
}

/**
 * A button/link/heading's inner label commonly shows up a second time as a
 * StaticText child with the exact same text — the parent's own `name`
 * already carries it, so the child is pure duplication. childIds reference
 * AXNode.nodeId (the AX-tree id), not backendDOMNodeId.
 */
function computeRedundantTextAxIds(byAxId: Map<string, AXNode>, meaningfulAxIds: Set<string>): Set<string> {
    const redundant = new Set<string>();
    function mark(axId: string) {
        for (const childId of byAxId.get(axId)?.childIds ?? []) {
            if (redundant.has(childId)) continue;
            redundant.add(childId);
            mark(childId);
        }
    }
    for (const axId of meaningfulAxIds) {
        if (byAxId.get(axId)?.role?.value !== "StaticText") mark(axId);
    }
    return redundant;
}

function toCompactEntry(node: AXNode): SnapshotEntry {
    return {
        // backendDOMNodeId (DOM domain), not nodeId (AX-tree-only id) — click/
        // type resolve via DOM.getBoxModel, which only accepts the former.
        i: node.backendDOMNodeId,
        r: node.role?.value,
        n: node.name?.value,
        ...(node.value?.value ? { v: String(node.value.value) } : {}),
    };
}

export function buildSnapshotNodes(nodes: AXNode[]): SnapshotEntry[] {
    const kept = nodes.filter(isMeaningfulAxNode);
    const byAxId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));
    const redundantTextAxIds = computeRedundantTextAxIds(byAxId, new Set(kept.map((n) => n.nodeId)));

    return kept
        .filter((node) => node.role?.value !== "StaticText" || !redundantTextAxIds.has(node.nodeId))
        .map(toCompactEntry);
}

export function buildRegionTree(nodes: AXNode[]): {
    tree: SnapshotEntry[];
    truncated: boolean;
} {
    if (nodes.length === 0) return { tree: [], truncated: false };

    const byAxId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));
    const meaningfulAxIds = new Set(nodes.filter(isMeaningfulAxNode).map((n) => n.nodeId));
    const redundantTextAxIds = computeRedundantTextAxIds(byAxId, meaningfulAxIds);
    let emitted = 0;
    let truncated = false;

    function buildChildren(axId: string): SnapshotEntry[] {
        const result: SnapshotEntry[] = [];
        for (const childId of byAxId.get(axId)?.childIds ?? []) {
            if (emitted >= MAX_REGION_NODES) {
                truncated = true;
                break;
            }
            const child = byAxId.get(childId);
            if (!child) continue;
            const childRole = child.role?.value;
            const isText = childRole === "StaticText" || childRole === "heading" || childRole === "paragraph";
            if (isText && redundantTextAxIds.has(childId)) continue;

            if (meaningfulAxIds.has(childId)) {
                emitted++;
                const entry = toCompactEntry(child);
                const grandChildren = buildChildren(childId);
                if (grandChildren.length > 0) entry.children = grandChildren;
                result.push(entry);
            } else {
                // Not meaningful itself (a plain wrapper div/span) — splice
                // its meaningful descendants into this level instead of
                // adding a content-free nesting layer per wrapper.
                result.push(...buildChildren(childId));
            }
        }
        return result;
    }

    // The requested element is whichever returned node isn't referenced as
    // anyone else's child — more robust than assuming array order.
    const referencedAsChild = new Set<string>();
    for (const n of nodes) for (const c of n.childIds ?? []) referencedAsChild.add(c);
    const root = nodes.find((n) => !referencedAsChild.has(n.nodeId)) ?? nodes[0];

    if (meaningfulAxIds.has(root.nodeId)) {
        const entry = toCompactEntry(root);
        const children = buildChildren(root.nodeId);
        if (children.length > 0) entry.children = children;
        return { tree: [entry], truncated };
    }
    return { tree: buildChildren(root.nodeId), truncated };
}

export function countTreeNodes(entries: SnapshotEntry[]): number {
    let count = 0;
    for (const entry of entries) {
        count += 1;
        if (entry.children) count += countTreeNodes(entry.children);
    }
    return count;
}

export async function getFullSnapshot(target: chrome.debugger.Debuggee): Promise<SnapshotEntry[]> {
    const axTreeResult = await sendCommand(target, "Accessibility.getFullAXTree", {});
    return buildSnapshotNodes(axTreeResult?.nodes || []);
}

export function formatCompactSnapshot(nodes: SnapshotEntry[]): string {
    return nodes
        .map((node) => {
            const idPart = node.i != null ? `[${node.i}] ` : "";
            const rolePart = node.r ?? "node";
            const namePart = node.n ? ` "${node.n.replace(/\n+/g, " ").trim()}"` : "";
            const valPart = node.v ? ` (v: "${node.v.replace(/\n+/g, " ").trim()}")` : "";
            return `${idPart}${rolePart}${namePart}${valPart}`;
        })
        .join("\n");
}

export async function handleSnapshotCommand(
    target: chrome.debugger.Debuggee,
    opts: { compact?: boolean; format?: string } = {},
): Promise<Record<string, unknown>> {
    const axTreeResult = await sendCommand(target, "Accessibility.getFullAXTree", {});
    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);
    const isCompact = opts.compact === true || opts.format === "compact";
    return {
        message: "Extracted and Filtered Accessibility Tree",
        totalRawNodes: nodes.length,
        filteredNodesCount: filteredNodes.length,
        ...(isCompact ? { compactNodes: formatCompactSnapshot(filteredNodes) } : { nodes: filteredNodes }),
    };
}

export async function handleQueryRegionCommand(
    target: chrome.debugger.Debuggee,
    selector: string | undefined,
): Promise<Record<string, unknown>> {
    if (!selector)
        return {
            error: "Missing selector",
            hint: "Pass a CSS selector for the container to scope into, e.g. 'form' or '.search-panel'.",
        };

    const docResult = await sendCommand(target, "DOM.getDocument", {
        depth: 0,
    });
    const rootNodeId = docResult?.root?.nodeId;
    if (!rootNodeId)
        return {
            error: "Failed to get document root",
            hint: "The page may still be loading; try again.",
        };

    const queryResult = await sendCommand(target, "DOM.querySelector", {
        nodeId: rootNodeId,
        selector,
    });
    if (!queryResult?.nodeId) {
        return {
            error: `No element matched selector "${selector}"`,
            hint: 'Check the selector against the page source, or use browser_inspect({action:"snapshot"}) first to find a container to scope into.',
        };
    }

    const describeResult = await sendCommand(target, "DOM.describeNode", {
        nodeId: queryResult.nodeId,
    });
    const backendNodeId = describeResult?.node?.backendNodeId;
    if (!backendNodeId) {
        return {
            error: "Failed to resolve matched element",
            hint: "Try a more specific selector.",
        };
    }

    const axResult = await sendCommand(target, "Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
    });
    const { tree, truncated } = buildRegionTree(axResult?.nodes || []);
    const nodeCount = countTreeNodes(tree);

    return {
        message: `Scoped to "${selector}" (${describeResult.node.nodeName}): ${nodeCount} element(s), nested by DOM structure — a field's label is its sibling in the same "children" array.${truncated ? ` Truncated at ${MAX_REGION_NODES} elements; use a narrower selector to see the rest.` : ""} Use these ids with browser_act's click/type or browser_inspect's inspect_element.`,
        selector,
        truncated,
        tree,
    };
}

/** Generates a filtered accessibility tree snapshot alongside an annotated visual screenshot. */
export async function handleVisualSnapshotCommand(target: chrome.debugger.Debuggee): Promise<Record<string, unknown>> {
    const axTreeResult = await sendCommand(target, "Accessibility.getFullAXTree", {});
    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);

    const toAnnotate = filteredNodes.filter((n) => n.i != null).slice(0, MAX_ANNOTATED);

    const boxes: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
    await Promise.all(
        toAnnotate.map(async (node) => {
            const boxModel = await sendCommand(target, "DOM.getBoxModel", {
                backendNodeId: node.i,
            });
            const quad = boxModel?.model?.content;
            if (quad) {
                const box = quadToBox(quad);
                if (box.w > 0 && box.h > 0) boxes.push({ id: node.i!, ...box });
            }
        }),
    );

    const shot = await captureAnnotatedScreenshot(target, boxes);
    if ("error" in shot) return shot;

    return {
        message: `Annotated ${boxes.length} interactive element(s) on screen. Each numbered box in the screenshot is a node id you can pass to browser_act's click/type.`,
        nodes: filteredNodes,
        format: shot.format,
        dataBase64: shot.dataBase64,
    };
}

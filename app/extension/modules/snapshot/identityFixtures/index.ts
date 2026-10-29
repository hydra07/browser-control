import type { Protocol } from "devtools-protocol";
import { buildSemanticCandidates } from "../index.js";
import type { SemanticState, SemanticStateMetadata, SemanticStateObservation } from "../semanticState.js";
import type { IdentityFixtureState, IdentityObservation, ObservedIdentityTarget } from "./types.js";

/** Adapts sanitized offline captures to the legacy collector without contacting Chrome. */
export function fixtureAX(input: IdentityFixtureState): Protocol.Accessibility.AXNode[] {
    if (input.snapshot.accessibility.length !== 1) throw new Error("Identity fixtures require exactly one frame");
    return input.snapshot.accessibility[0].nodes.map((node) => ({
        nodeId: node.id,
        ignored: node.ignored ?? false,
        parentId: node.parentId,
        childIds: node.children ? [...node.children] : undefined,
        backendDOMNodeId: node.handle,
        role: node.role ? { type: "role", value: node.role } : undefined,
        name: node.name ? { type: "computedString", value: node.name } : undefined,
        value: node.value ? { type: "string", value: node.value } : undefined,
    }));
}

/** Joins engine output to independent physical witnesses, never to literal oracle ref numbers. */
export function observeIdentity(
    state: SemanticState,
    input: IdentityFixtureState,
    nodes: readonly Protocol.Accessibility.AXNode[] = fixtureAX(input),
    observation: SemanticStateObservation = {},
    metadata: SemanticStateMetadata = {},
): IdentityObservation {
    const candidates = buildSemanticCandidates(nodes);
    const update = state.update(observation, candidates, metadata);
    if (update.snapshot.truncated || update.snapshot.nodes.length !== candidates.length) {
        throw new Error("Identity fixture exceeded the test observation budget");
    }
    const resolved = new Map<string, number>();
    for (const node of update.snapshot.nodes) {
        const target = state.resolve(node.ref, update.snapshot.scope);
        if (target) resolved.set(node.ref, target.backendNodeId);
    }
    const targets: IdentityObservation["targets"] = new Map();
    for (const witness of input.nodes) {
        const matches = candidates.flatMap((candidate, index) =>
            candidate.backendNodeId === witness.handle ? [index] : [],
        );
        if (matches.length !== 1) throw new Error(`Expected one AX candidate for ${witness.key}`);
        const node = update.snapshot.nodes[matches[0]];
        if (!node) throw new Error(`Missing engine node for ${witness.key}`);
        if (!node.identityUncertain && resolved.get(node.ref) !== witness.handle) {
            throw new Error(`Engine output no longer matches collector order for ${witness.key}`);
        }
        targets.set(witness.key, { ...witness, node });
    }
    return { update, targets, resolved };
}

export function identityTarget(observation: IdentityObservation, key: string): ObservedIdentityTarget {
    const target = observation.targets.get(key);
    if (!target) throw new Error(`Missing identity witness for ${key}`);
    return target;
}

export function retainedIdentity(before: IdentityObservation, after: IdentityObservation, key: string): boolean {
    const previousScope = before.update.snapshot.scope;
    const currentScope = after.update.snapshot.scope;
    if (
        previousScope.documentId !== currentScope.documentId ||
        previousScope.tabId !== currentScope.tabId ||
        previousScope.frameId !== currentScope.frameId
    ) {
        throw new Error("Physical retention requires the same document scope");
    }
    const previous = identityTarget(before, key);
    const current = identityTarget(after, key);
    if (previous.physical !== current.physical || previous.handle !== current.handle) {
        throw new Error(`Retention needs a continuous physical witness for ${key}`);
    }
    return previous.node.ref === current.node.ref && after.resolved.get(previous.node.ref) === current.handle;
}

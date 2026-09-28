import type {
    DocumentScope,
    RuntimeTargetRef,
    SemanticDelta,
    SemanticNode,
    SemanticSnapshot,
} from "@browsercontrol/shared";

const DEFAULT_MAX_NODES = 500;
const MAX_DELTA_NODES = 100;
let nextDocumentSequence = 1;

export interface SemanticCandidate {
    role?: string;
    name?: string;
    value?: string;
    backendNodeId?: number;
    structuralKey?: string;
    parentStructuralKey?: string;
}

export interface SemanticStateOptions {
    tabId: number;
    frameId: string;
    loaderId?: string;
    documentId?: string;
    documentIdFactory?: () => string;
    maxNodes?: number;
}

export interface SemanticStateObservation {
    frameId?: string;
    loaderId?: string;
    documentReplaced?: boolean;
}

export interface SemanticStateMetadata {
    url?: string;
    title?: string;
}

export interface SemanticStateUpdate {
    snapshot: SemanticSnapshot;
    delta: SemanticDelta;
}

type InternalEntry = SemanticNode & {
    structuralKey: string;
    parentStructuralKey?: string;
    scope: DocumentScope;
    lastSeenRevision: string;
    confidence: number;
    status: RuntimeTargetRef["status"];
};

function newDocumentId(): string {
    return `d${nextDocumentSequence++}`;
}

function identityKey(candidate: SemanticCandidate): string {
    return [candidate.structuralKey ?? "", candidate.role ?? "", candidate.name ?? ""].join("|");
}

function nodeSignature(node: SemanticNode): string {
    return JSON.stringify({
        ref: node.ref,
        role: node.role,
        name: node.name,
        value: node.value,
        parentRef: node.parentRef,
        children: node.children,
        identityUncertain: node.identityUncertain,
    });
}

function toPublicNode(entry: InternalEntry): SemanticNode {
    return {
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        value: entry.value,
        parentRef: entry.parentRef,
        children: entry.children,
        ...(entry.status === "uncertain" ? { identityUncertain: true } : {}),
    };
}

function sameScope(left: DocumentScope, right: DocumentScope): boolean {
    const loaderMatches = left.loaderId == null || right.loaderId == null || left.loaderId === right.loaderId;
    return (
        loaderMatches &&
        left.documentId === right.documentId &&
        left.tabId === right.tabId &&
        left.frameId === right.frameId
    );
}

/** Maintains document-scoped semantic refs independently from snapshot revisions. */
export class SemanticState {
    private scope: DocumentScope;
    private readonly createDocumentId: () => string;
    private readonly maxNodes: number;
    private revisionNumber: number;
    private nextRefNumber: number;
    private readonly entries: Map<string, InternalEntry>;
    private currentNodes: SemanticNode[];
    private currentRevision: string | undefined;

    constructor(options: SemanticStateOptions) {
        this.createDocumentId = options.documentIdFactory ?? newDocumentId;
        this.maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES);
        this.scope = {
            documentId: options.documentId ?? this.createDocumentId(),
            tabId: options.tabId,
            frameId: options.frameId,
            ...(options.loaderId ? { loaderId: options.loaderId } : {}),
        };
        this.revisionNumber = 0;
        this.nextRefNumber = 1;
        this.entries = new Map();
        this.currentNodes = [];
        this.currentRevision = undefined;
    }

    public getScope(): DocumentScope {
        return { ...this.scope };
    }

    public getRevision(): string | undefined {
        return this.currentRevision;
    }

    public resolve(ref: string, scope: DocumentScope): (RuntimeTargetRef & { backendNodeId: number }) | null {
        const entry = this.entries.get(ref);
        if (!entry) return null;
        if (entry.status !== "active" || !sameScope(entry.scope, scope) || entry.internalBackendNodeId == null) {
            return null;
        }
        return {
            ref: entry.ref,
            scope: { ...entry.scope },
            lastSeenRevision: entry.lastSeenRevision ?? "",
            confidence: entry.confidence ?? 0,
            status: entry.status,
            backendNodeId: entry.internalBackendNodeId,
        };
    }

    public getRef(ref: string): RuntimeTargetRef | null {
        const entry = this.entries.get(ref);
        if (!entry) return null;
        return {
            ref: entry.ref,
            scope: { ...entry.scope },
            lastSeenRevision: entry.lastSeenRevision ?? "",
            confidence: entry.confidence ?? 0,
            status: entry.status,
        };
    }

    public update(
        observation: SemanticStateObservation,
        candidates: readonly SemanticCandidate[],
        metadata: SemanticStateMetadata = {},
    ): SemanticStateUpdate {
        this.observeDocument(observation);

        const previousRevision = this.currentRevision;
        const previousNodes = this.currentNodes;
        const boundedCandidates = candidates.slice(0, this.maxNodes);
        const truncated = boundedCandidates.length < candidates.length;
        const nextRevision = `r${++this.revisionNumber}`;
        const previousActive = [...this.entries.values()].filter(
            (entry) =>
                sameScope(entry.scope, this.scope) && (entry.status === "active" || entry.status === "uncertain"),
        );
        const previousByKey = this.groupByKey(previousActive, (entry) => entry.structuralKey);
        const currentMatches = boundedCandidates.map((candidate) => ({
            candidate,
            key: identityKey(candidate),
        }));
        const currentByKey = this.groupByKey(currentMatches, (match) => match.key);
        const usedRefs = new Set<string>();
        const nextEntries: InternalEntry[] = [];

        for (const current of currentMatches) {
            const prior = previousByKey.get(current.key) ?? [];
            const currentGroup = currentByKey.get(current.key) ?? [];
            const reusable = prior.length === 1 && currentGroup.length === 1 ? prior[0] : undefined;
            const backendMatches = prior.filter(
                (entry) =>
                    current.candidate.backendNodeId != null &&
                    entry.internalBackendNodeId === current.candidate.backendNodeId,
            );
            const backendReusable = !reusable && backendMatches.length === 1 ? backendMatches[0] : undefined;
            const matched = reusable ?? backendReusable;
            const uncertain = !reusable && !backendReusable && (prior.length > 0 || currentGroup.length > 1);
            const ref = matched && !usedRefs.has(matched.ref) ? matched.ref : `e${this.nextRefNumber++}`;
            usedRefs.add(ref);
            nextEntries.push({
                ref,
                role: current.candidate.role,
                name: current.candidate.name,
                value: current.candidate.value,
                internalBackendNodeId: current.candidate.backendNodeId,
                structuralKey: current.key,
                parentStructuralKey: current.candidate.parentStructuralKey,
                scope: { ...this.scope },
                lastSeenRevision: nextRevision,
                confidence: uncertain ? 0.5 : 1,
                status: uncertain ? "uncertain" : "active",
            });
        }

        for (const entry of previousActive) {
            if (!usedRefs.has(entry.ref)) {
                this.entries.set(entry.ref, { ...entry, status: "stale" });
            }
        }

        const byStructuralKey = new Map<string, InternalEntry[]>();
        for (const entry of nextEntries) {
            const list = byStructuralKey.get(entry.structuralKey) ?? [];
            list.push(entry);
            byStructuralKey.set(entry.structuralKey, list);
        }
        for (const entry of nextEntries) {
            const parents = entry.parentStructuralKey ? (byStructuralKey.get(entry.parentStructuralKey) ?? []) : [];
            if (parents.length === 1) entry.parentRef = parents[0]?.ref;
        }

        for (const entry of nextEntries) this.entries.set(entry.ref, entry);
        const childrenByParent = new Map<string, string[]>();
        for (const entry of nextEntries) {
            if (!entry.parentRef) continue;
            const children = childrenByParent.get(entry.parentRef) ?? [];
            children.push(entry.ref);
            childrenByParent.set(entry.parentRef, children);
        }
        for (const entry of nextEntries) entry.children = childrenByParent.get(entry.ref);
        const snapshotNodes = nextEntries.map(toPublicNode);
        const uncertainRefs = snapshotNodes.filter((node) => node.identityUncertain).map((node) => node.ref);
        const delta = this.makeDelta(
            previousRevision,
            previousNodes,
            snapshotNodes,
            uncertainRefs,
            truncated,
            nextRevision,
        );
        const snapshot: SemanticSnapshot = {
            schemaVersion: 2,
            revision: nextRevision,
            scope: { ...this.scope },
            ...(metadata.url ? { url: metadata.url } : {}),
            ...(metadata.title ? { title: metadata.title } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(uncertainRefs.length > 0 ? { identityUncertainty: true } : {}),
            nodes: snapshotNodes,
        };

        this.currentRevision = nextRevision;
        this.currentNodes = snapshotNodes;
        return { snapshot, delta };
    }

    private observeDocument(observation: SemanticStateObservation): void {
        const frameChanged = observation.frameId != null && observation.frameId !== this.scope.frameId;
        const loaderChanged =
            observation.loaderId != null && this.scope.loaderId != null && observation.loaderId !== this.scope.loaderId;
        if (frameChanged || loaderChanged || observation.documentReplaced) {
            for (const entry of this.entries.values()) entry.status = "stale";
            this.scope = {
                documentId: this.createDocumentId(),
                tabId: this.scope.tabId,
                frameId: observation.frameId ?? this.scope.frameId,
                ...(observation.loaderId ? { loaderId: observation.loaderId } : {}),
            };
            this.currentRevision = undefined;
            this.currentNodes = [];
            this.nextRefNumber = 1;
            return;
        }
        if (observation.loaderId != null && this.scope.loaderId == null) {
            this.scope = { ...this.scope, loaderId: observation.loaderId };
        }
        if (observation.frameId != null) this.scope = { ...this.scope, frameId: observation.frameId };
    }

    private groupByKey<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
        const groups = new Map<string, T[]>();
        for (const item of items) {
            const key = keyOf(item);
            const group = groups.get(key) ?? [];
            group.push(item);
            groups.set(key, group);
        }
        return groups;
    }

    private makeDelta(
        fromRevision: string | undefined,
        previousNodes: readonly SemanticNode[],
        currentNodes: readonly SemanticNode[],
        uncertainRefs: string[],
        sourceTruncated: boolean,
        toRevision: string,
    ): SemanticDelta {
        const previousByRef = new Map(previousNodes.map((node) => [node.ref, node]));
        const currentByRef = new Map(currentNodes.map((node) => [node.ref, node]));
        const added = currentNodes.filter((node) => !previousByRef.has(node.ref));
        const changed = currentNodes.filter((node) => {
            const previous = previousByRef.get(node.ref);
            return previous != null && nodeSignature(previous) !== nodeSignature(node);
        });
        const removed = previousNodes.filter((node) => !currentByRef.has(node.ref)).map((node) => node.ref);
        const truncated =
            sourceTruncated ||
            added.length > MAX_DELTA_NODES ||
            changed.length > MAX_DELTA_NODES ||
            removed.length > MAX_DELTA_NODES ||
            uncertainRefs.length > MAX_DELTA_NODES;
        return {
            schemaVersion: 2,
            ...(fromRevision ? { fromRevision } : {}),
            toRevision,
            scope: { ...this.scope },
            added: added.slice(0, MAX_DELTA_NODES),
            changed: changed.slice(0, MAX_DELTA_NODES),
            removed: removed.slice(0, MAX_DELTA_NODES),
            uncertainRefs: uncertainRefs.slice(0, MAX_DELTA_NODES),
            ...(truncated ? { truncated: true } : {}),
        };
    }
}

import type { SemanticNode } from "@browsercontrol/shared";
import type { SemanticStateUpdate } from "../semanticState.js";

export interface CapturedAccessNode {
    id: string;
    parentId?: string;
    children?: string[];
    handle?: number;
    role?: string;
    name?: string;
    value?: string;
    ignored?: boolean;
}

export interface IdentityWitness {
    key: string;
    physical: string;
    handle: number;
    anchor: string;
}

export interface IdentityFixtureState {
    document: string;
    nodes: IdentityWitness[];
    snapshot: {
        accessibility: { frameId: string; nodes: CapturedAccessNode[] }[];
    };
}

export interface IdentityObservation {
    update: SemanticStateUpdate;
    targets: Map<string, ObservedIdentityTarget>;
    resolved: Map<string, number>;
}

export type ObservedIdentityTarget = IdentityWitness & { node: SemanticNode };

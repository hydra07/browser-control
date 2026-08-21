import type { AxInfo } from "../actions/types.js";
import type { SnapshotEntry } from "../snapshot/types.js";

export type ResolvedStepTarget = {
    backendNodeId: number;
    matched: { role?: string; name?: string } | { selector: string };
    // Always populated regardless of match method, so isRiskyTarget has one
    // consistent shape to check.
    axInfo: AxInfo;
    ambiguous?: boolean;
};

export type SnapshotDelta = {
    added: SnapshotEntry[];
    changed: SnapshotEntry[];
    removed: Array<{ role?: string; name?: string }>;
    truncated?: boolean;
};

export type FlowStepResult = {
    index: number;
    action: string;
    matched?: { role?: string; name?: string } | { selector: string };
    ambiguous?: boolean;
    success: boolean;
    error?: string;
    delta?: SnapshotDelta;
};

export type FlowReport = {
    success: boolean;
    stoppedAtStep?: number;
    reason?: "too_many_steps" | "not_found" | "risky_action_blocked" | "action_failed" | "assert_failed" | "timeout";
    message?: string;
    steps: FlowStepResult[];
    finalSnapshot?: SnapshotEntry[];
};

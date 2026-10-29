export type ActionStatus = "completed" | "blocked" | "cancelled" | "failed" | "outcome_unknown";
export type ActionKind = "click" | "press" | "insert_text" | "navigate" | "create_tab" | "close_tab" | "scroll";
export type InputState = "not_sent" | "write_attempted" | "acknowledged";

export interface ActionResult {
    actionId: string;
    kind: ActionKind;
    status: ActionStatus;
    /** True when a write was attempted, including an uncertain partial transport write. */
    dispatched: boolean;
    inputState: InputState;
    acknowledged: boolean;
    cleanupComplete: boolean;
    startedAt: number;
    dispatchedAt: number | null;
    finishedAt: number;
    bbox: { x: number; y: number; width: number; height: number } | null;
    verified: boolean;
    observation: "not_observed" | "snapshot_at" | "condition_met";
}

const statuses = ["completed", "blocked", "cancelled", "failed", "outcome_unknown"] satisfies ActionStatus[];
const kinds = ["click", "press", "insert_text", "navigate", "create_tab", "close_tab", "scroll"] satisfies ActionKind[];
const inputStates = ["not_sent", "write_attempted", "acknowledged"] satisfies InputState[];

/** Validates direct input results without inferring UI verification from a protocol acknowledgement. */
export function isActionResult(value: unknown): value is ActionResult {
    if (!isRecord(value)) return false;
    if (typeof value.actionId !== "string" || value.actionId.length > 128 || !/^a_[A-Za-z0-9_-]+$/.test(value.actionId))
        return false;
    if (
        !statuses.some((status) => status === value.status) ||
        !kinds.some((kind) => kind === value.kind) ||
        !inputStates.some((state) => state === value.inputState)
    )
        return false;
    if (
        typeof value.dispatched !== "boolean" ||
        typeof value.acknowledged !== "boolean" ||
        typeof value.cleanupComplete !== "boolean" ||
        typeof value.verified !== "boolean"
    )
        return false;
    if (!timestamp(value.startedAt) || !timestamp(value.finishedAt) || value.finishedAt < value.startedAt) return false;
    if (
        value.dispatched !== (value.inputState !== "not_sent") ||
        value.acknowledged !== (value.inputState === "acknowledged")
    )
        return false;
    if (value.acknowledged && !value.cleanupComplete) return false;
    if (value.dispatched && !value.cleanupComplete && value.status !== "outcome_unknown") return false;
    if (value.dispatched) {
        if (
            !timestamp(value.dispatchedAt) ||
            value.dispatchedAt < value.startedAt ||
            value.dispatchedAt > value.finishedAt
        )
            return false;
    } else if (value.dispatchedAt !== null) return false;
    if (value.status === "completed" && (!value.dispatched || !value.acknowledged || !value.cleanupComplete))
        return false;
    if (value.status === "outcome_unknown" && !value.dispatched) return false;
    if (
        value.observation !== "not_observed" &&
        value.observation !== "snapshot_at" &&
        value.observation !== "condition_met"
    )
        return false;
    if (value.verified && (value.status !== "completed" || value.observation !== "condition_met")) return false;
    if (value.bbox !== null) {
        if (!isRecord(value.bbox)) return false;
        const { x, y, width, height } = value.bbox;
        if (![x, y, width, height].every((number) => typeof number === "number" && Number.isFinite(number)))
            return false;
        if (typeof width !== "number" || typeof height !== "number" || width < 0 || height < 0) return false;
    }
    return true;
}

function timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

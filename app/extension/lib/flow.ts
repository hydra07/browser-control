// The engine behind run_flow (one compact report + a final snapshot) and
// explore_flow (a snapshot delta after every step) — same steps, same real
// side effects, explore_flow just reports more per step for validating an
// unfamiliar UI before switching to run_flow for repeat runs.
import type { FlowStep } from "@browsercontrol/shared";
import { sendCommand } from "./cdp.js";
import { pageDelay } from "./overlay.js";
import { getAxInfoForNode, isRiskyTarget, performClick, performDrag, performPressKey, performScroll, performType } from "./actions.js";
import type { ActionResult, AxInfo } from "./actions.js";
import { getFullSnapshot } from "./snapshot.js";
import type { SnapshotEntry } from "./snapshot.js";

type ResolvedStepTarget = {
    backendNodeId: number;
    matched: { role?: string; name?: string } | { selector: string };
    // Always populated regardless of match method, so isRiskyTarget has one
    // consistent shape to check.
    axInfo: AxInfo;
    ambiguous?: boolean;
};

// Resolves a step's target against the LIVE page at execution time — never
// a nodeId, since the script is written before later steps' DOM state
// exists yet. role+name matching mirrors replay.ts's server-side identity
// match (survives a re-render the way backendDOMNodeId never does).
async function resolveStepTarget(
    target: chrome.debugger.Debuggee,
    step: FlowStep,
): Promise<ResolvedStepTarget | null> {
    if (step.selector) {
        const docResult = await sendCommand(target, "DOM.getDocument", {
            depth: 0,
        });
        const rootNodeId = docResult?.root?.nodeId;
        if (!rootNodeId) return null;
        const queryResult = await sendCommand(target, "DOM.querySelector", {
            nodeId: rootNodeId,
            selector: step.selector,
        });
        if (!queryResult?.nodeId) return null;
        const describeResult = await sendCommand(target, "DOM.describeNode", {
            nodeId: queryResult.nodeId,
        });
        const backendNodeId = describeResult?.node?.backendNodeId;
        if (!backendNodeId) return null;
        const axInfo = await getAxInfoForNode(target, backendNodeId);
        return { backendNodeId, matched: { selector: step.selector }, axInfo };
    }
    if (step.role && step.name) {
        const axTreeResult = await sendCommand(
            target,
            "Accessibility.getFullAXTree",
            {},
        );
        const nodes = axTreeResult?.nodes || [];
        const candidates = nodes.filter(
            (n) =>
                n.role?.value === step.role &&
                n.name?.value === step.name &&
                n.backendDOMNodeId != null,
        );
        if (candidates.length === 0) return null;
        return {
            backendNodeId: candidates[0].backendDOMNodeId!,
            matched: { role: step.role, name: step.name },
            axInfo: { role: step.role, name: step.name },
            ambiguous: candidates.length > 1,
        };
    }
    return null;
}

function describeStepTarget(step: FlowStep): string {
    if (step.selector) return `selector "${step.selector}"`;
    if (step.role || step.name)
        return `${step.role ?? "element"} "${step.name ?? ""}"`;
    return "the currently focused element";
}

type SnapshotDelta = {
    added: SnapshotEntry[];
    changed: SnapshotEntry[];
    removed: Array<{ role?: string; name?: string }>;
    truncated?: boolean;
};

type FlowStepResult = {
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
    reason?:
        | "too_many_steps"
        | "not_found"
        | "risky_action_blocked"
        | "action_failed"
        | "assert_failed"
        | "timeout";
    message?: string;
    steps: FlowStepResult[];
    finalSnapshot?: SnapshotEntry[];
};

const MAX_FLOW_STEPS = 20;
const WAIT_FOR_POLL_MS = 250;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 3000;
// A full page snapshot after every step cost 87k+ tokens in one real
// 10-call explore_flow session (77% of that session's total tool-call
// spend) — mostly the SAME static content re-emitted every step. A diff
// against the previous step is both smaller and more directly useful.
const MAX_DELTA_ENTRIES = 30;

function snapshotEntryKey(e: SnapshotEntry): string {
    return `${e.r ?? ""}::${e.n ?? ""}`;
}

/** Diffs two flat snapshots by role+name identity (backendDOMNodeId isn't stable across a re-render). `prev` undefined reports everything as "added". */
function diffSnapshots(
    prev: SnapshotEntry[] | undefined,
    curr: SnapshotEntry[],
): SnapshotDelta {
    const prevMap = new Map((prev ?? []).map((e) => [snapshotEntryKey(e), e]));
    const currMap = new Map(curr.map((e) => [snapshotEntryKey(e), e]));

    const added: SnapshotEntry[] = [];
    const changed: SnapshotEntry[] = [];
    for (const [key, entry] of currMap) {
        const prevEntry = prevMap.get(key);
        if (!prevEntry) added.push(entry);
        else if (prevEntry.v !== entry.v) changed.push(entry);
    }
    const removed: Array<{ role?: string; name?: string }> = [];
    for (const [key, entry] of prevMap) {
        if (!currMap.has(key)) removed.push({ role: entry.r, name: entry.n });
    }

    const truncated =
        added.length > MAX_DELTA_ENTRIES ||
        changed.length > MAX_DELTA_ENTRIES ||
        removed.length > MAX_DELTA_ENTRIES;
    return {
        added: added.slice(0, MAX_DELTA_ENTRIES),
        changed: changed.slice(0, MAX_DELTA_ENTRIES),
        removed: removed.slice(0, MAX_DELTA_ENTRIES),
        ...(truncated ? { truncated: true } : {}),
    };
}

// Stops at the first step that doesn't resolve, fails, or is blocked as
// risky — no partial-credit "keep going and see", since a script guessed
// from a snapshot compounding one wrong step into several is worse than
// stopping and reporting.
export async function runFlowSteps(
    target: chrome.debugger.Debuggee,
    steps: FlowStep[],
    opts: { captureEachStep: boolean },
): Promise<FlowReport> {
    if (steps.length > MAX_FLOW_STEPS) {
        return {
            success: false,
            reason: "too_many_steps",
            message: `Flow has ${steps.length} steps; max is ${MAX_FLOW_STEPS} per call. Split into multiple browser_act({action:"run_flow"}) calls.`,
            steps: [],
        };
    }

    const results: FlowStepResult[] = [];
    const stop = (
        index: number,
        reason: FlowReport["reason"],
        message: string,
    ): FlowReport => ({
        success: false,
        stoppedAtStep: index,
        reason,
        message,
        steps: results,
    });

    // Baseline for step 0's delta — without it, step 0 would report the
    // entire page as "added".
    let previousSnapshot: SnapshotEntry[] | undefined;
    if (opts.captureEachStep) previousSnapshot = await getFullSnapshot(target);

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const needsTarget =
            step.action !== "scroll" &&
            step.action !== "drag" &&
            !(step.action === "press_key" && !step.role && !step.selector);

        let resolved: ResolvedStepTarget | null = null;

        if (needsTarget) {
            if (step.action === "wait_for") {
                const timeoutMs = step.timeoutMs ?? WAIT_FOR_DEFAULT_TIMEOUT_MS;
                const deadline = Date.now() + timeoutMs;
                do {
                    resolved = await resolveStepTarget(target, step);
                    if (resolved || Date.now() >= deadline) break;
                    await pageDelay(target, WAIT_FOR_POLL_MS);
                } while (true);
                if (!resolved) {
                    results.push({
                        index: i,
                        action: step.action,
                        success: false,
                        error: `Timed out after ${timeoutMs}ms`,
                    });
                    return stop(
                        i,
                        "timeout",
                        `Step ${i} (wait_for) timed out after ${timeoutMs}ms waiting for ${describeStepTarget(step)}.`,
                    );
                }
            } else {
                resolved = await resolveStepTarget(target, step);
                if (!resolved) {
                    results.push({
                        index: i,
                        action: step.action,
                        success: false,
                        error: "not_found",
                    });
                    return stop(
                        i,
                        "not_found",
                        `Step ${i} (${step.action}) found no element matching ${describeStepTarget(step)}. Stopped before continuing — take a fresh browser_inspect({action:"snapshot"}) and correct this step.`,
                    );
                }
            }

            if (isRiskyTarget(resolved.axInfo) && !step.confirmRisky) {
                results.push({
                    index: i,
                    action: step.action,
                    matched: resolved.matched,
                    ambiguous: resolved.ambiguous,
                    success: false,
                    error: "risky_action_blocked",
                });
                return stop(
                    i,
                    "risky_action_blocked",
                    `Step ${i} (${step.action}) targets ${describeStepTarget(step)} (${resolved.axInfo.role ?? "element"} "${resolved.axInfo.name ?? ""}"), which looks potentially destructive/irreversible. Confirm this is intended with your user, then re-run with steps[${i}].confirmRisky:true.`,
                );
            }
        }

        let actionResult: ActionResult;
        switch (step.action) {
            case "click":
                actionResult = await performClick(
                    target,
                    resolved!.backendNodeId,
                    { fast: true },
                );
                break;
            case "type":
                actionResult = await performType(
                    target,
                    resolved?.backendNodeId,
                    step.text ?? "",
                    { fast: true },
                );
                break;
            case "press_key":
                actionResult = await performPressKey(
                    target,
                    step.key ?? "",
                    resolved?.backendNodeId,
                    { fast: true },
                );
                break;
            case "scroll":
                actionResult = await performScroll(
                    target,
                    step.deltaX || 0,
                    step.deltaY || 0,
                    { fast: true },
                );
                break;
            case "drag":
                actionResult =
                    step.fromX != null && step.fromY != null && step.toX != null && step.toY != null
                        ? await performDrag(
                              target,
                              step.fromX,
                              step.fromY,
                              step.toX,
                              step.toY,
                              { fast: true },
                          )
                        : {
                              error: "Missing fromX/fromY/toX/toY",
                              hint: "action:'drag' needs all four viewport coordinates.",
                          };
                break;
            case "wait_for":
                actionResult = {
                    success: true,
                    message: `Found ${describeStepTarget(step)}`,
                };
                break;
            case "assert_text": {
                const text = resolved!.axInfo.name ?? "";
                actionResult =
                    step.contains && text.includes(step.contains)
                        ? {
                              success: true,
                              message: `"${step.contains}" found in "${text}"`,
                          }
                        : {
                              error: `Expected text containing "${step.contains ?? ""}", found "${text}"`,
                          };
                break;
            }
        }

        const success = "success" in actionResult;
        const errorMessage =
            "error" in actionResult ? actionResult.error : undefined;
        results.push({
            index: i,
            action: step.action,
            matched: resolved?.matched,
            ambiguous: resolved?.ambiguous,
            success,
            error: errorMessage,
        });
        if (opts.captureEachStep) {
            // What changed as a result of THIS step, not a full re-dump.
            const currentSnapshot = await getFullSnapshot(target);
            results[results.length - 1].delta = diffSnapshots(
                previousSnapshot,
                currentSnapshot,
            );
            previousSnapshot = currentSnapshot;
        }

        if (!success) {
            return stop(
                i,
                step.action === "assert_text"
                    ? "assert_failed"
                    : "action_failed",
                `Step ${i} (${step.action}) failed: ${errorMessage}`,
            );
        }
    }

    // Reuse the last step's already-captured snapshot instead of a
    // redundant extra fetch when explore_flow already has it fresh.
    const finalSnapshot =
        opts.captureEachStep && previousSnapshot
            ? previousSnapshot
            : await getFullSnapshot(target);
    return { success: true, steps: results, finalSnapshot };
}

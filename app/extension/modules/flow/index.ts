/**
 * Flow execution engine behind run_flow and explore_flow commands.
 * Resolves targets against live DOM/AXTree dynamically per step.
 */
import type { FlowStep } from "@browsercontrol/shared";
import { sendCommand } from "../../libs/cdp.js";
import type { ActionResult } from "../actions/index.js";
import {
    getAxInfoForNode,
    isRiskyTarget,
    performClick,
    performDrag,
    performPressKey,
    performScroll,
    performType,
} from "../actions/index.js";
import { pageDelay } from "../overlay/index.js";
import type { SnapshotEntry } from "../snapshot/index.js";
import { getFullSnapshot } from "../snapshot/index.js";
import { MAX_DELTA_ENTRIES, MAX_FLOW_STEPS, WAIT_FOR_DEFAULT_TIMEOUT_MS, WAIT_FOR_POLL_MS } from "./constants.js";
import type { FlowReport, ResolvedStepTarget, SnapshotDelta } from "./types.js";

export type { FlowReport } from "./types.js";

/** Resolves step target against live page accessibility tree or CSS selector. */
async function resolveStepTarget(target: chrome.debugger.Debuggee, step: FlowStep): Promise<ResolvedStepTarget | null> {
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
        const axTreeResult = await sendCommand(target, "Accessibility.getFullAXTree", {});
        const nodes = axTreeResult?.nodes || [];
        const candidates = nodes.filter(
            (n) => n.role?.value === step.role && n.name?.value === step.name && n.backendDOMNodeId != null,
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
    if (step.role || step.name) return `${step.role ?? "element"} "${step.name ?? ""}"`;
    return "the currently focused element";
}

function snapshotEntryKey(e: SnapshotEntry): string {
    return `${e.r ?? ""}::${e.n ?? ""}`;
}

/** Diffs two flat snapshots by role+name identity. */
function diffSnapshots(prev: SnapshotEntry[] | undefined, curr: SnapshotEntry[]): SnapshotDelta {
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
        added.length > MAX_DELTA_ENTRIES || changed.length > MAX_DELTA_ENTRIES || removed.length > MAX_DELTA_ENTRIES;
    return {
        added: added.slice(0, MAX_DELTA_ENTRIES),
        changed: changed.slice(0, MAX_DELTA_ENTRIES),
        removed: removed.slice(0, MAX_DELTA_ENTRIES),
        ...(truncated ? { truncated: true } : {}),
    };
}

/** Executes sequential action steps on the page, halting immediately on any failure or unconfirmed risk. */
export async function runFlowSteps(
    target: chrome.debugger.Debuggee,
    steps: FlowStep[],
    opts: { captureEachStep: boolean; returnSnapshot?: boolean },
): Promise<FlowReport> {
    if (steps.length > MAX_FLOW_STEPS) {
        return {
            success: false,
            reason: "too_many_steps",
            message: `Flow has ${steps.length} steps; max is ${MAX_FLOW_STEPS} per call. Split into multiple browser_act({action:"run_flow"}) calls.`,
            steps: [],
        };
    }

    const results: FlowReport["steps"] = [];
    const stop = (index: number, reason: FlowReport["reason"], message: string): FlowReport => ({
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
                actionResult = await performClick(target, resolved!.backendNodeId, { fast: true });
                break;
            case "type":
                actionResult = await performType(target, resolved?.backendNodeId, step.text ?? "", { fast: true });
                break;
            case "press_key":
                actionResult = await performPressKey(target, step.key ?? "", resolved?.backendNodeId, { fast: true });
                break;
            case "scroll":
                actionResult = await performScroll(target, step.deltaX || 0, step.deltaY || 0, { fast: true });
                break;
            case "drag":
                actionResult = await performDrag(target, step.fromX, step.fromY, step.toX, step.toY, {
                    fast: true,
                    shape: step.shape,
                    shapeParams: step.shapeParams,
                    path: step.path,
                    stepsCount: step.stepsCount,
                    easing: step.easing,
                    button: step.button,
                });
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
        const stepErrorMessage = "error" in actionResult ? actionResult.error : undefined;
        results.push({
            index: i,
            action: step.action,
            matched: resolved?.matched,
            ambiguous: resolved?.ambiguous,
            success,
            error: stepErrorMessage,
        });
        if (opts.captureEachStep) {
            // What changed as a result of THIS step, not a full re-dump.
            const currentSnapshot = await getFullSnapshot(target);
            results[results.length - 1].delta = diffSnapshots(previousSnapshot, currentSnapshot);
            previousSnapshot = currentSnapshot;
        }

        if (!success) {
            return stop(
                i,
                step.action === "assert_text" ? "assert_failed" : "action_failed",
                `Step ${i} (${step.action}) failed: ${stepErrorMessage}`,
            );
        }
    }

    // Only capture finalSnapshot if explicitly requested or in explore mode.
    // Plain agent runs omit it by default to save thousands of tokens.
    let finalSnapshot: SnapshotEntry[] | undefined;
    if (opts.returnSnapshot || opts.captureEachStep) {
        finalSnapshot = opts.captureEachStep && previousSnapshot ? previousSnapshot : await getFullSnapshot(target);
    }
    return {
        success: true,
        message: `Successfully executed ${steps.length} step(s).`,
        steps: results,
        ...(finalSnapshot ? { finalSnapshot } : {}),
    };
}

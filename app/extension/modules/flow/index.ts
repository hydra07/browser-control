/**
 * Flow execution engine behind run_flow and explore_flow commands.
 * Resolves targets against live DOM/AXTree dynamically per step.
 */

import type { DriftKind, ExpectedTransition, FailureEvent, FlowStep, FlowStepV2 } from "@browsercontrol/shared";
import { normalizeFlowStep, toFlowTargetDescriptor } from "@browsercontrol/shared";
import { sendCommand } from "../../libs/cdp.js";
import { emitActionLifecycle } from "../actions/events.js";
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
import { emitAssertionEvent, emitFailureEvent } from "../evidence/index.js";
import { pageDelay } from "../overlay/index.js";
import type { SnapshotEntry } from "../snapshot/index.js";
import { getFullSnapshot } from "../snapshot/index.js";
import { waitForStableDom } from "../wait/index.js";
import {
    DEFAULT_STEP_TIMEOUT_MS,
    MAX_DELTA_ENTRIES,
    MAX_FLOW_STEPS,
    WAIT_FOR_DEFAULT_TIMEOUT_MS,
    WAIT_FOR_POLL_MS,
} from "./constants.js";
import { selectUniqueCandidate } from "./resolution.js";
import type { FlowReport, ResolvedStepTarget, SnapshotDelta } from "./types.js";

export type { FlowReport } from "./types.js";

function normalizeRole(role?: string): string[] {
    if (!role) return [];
    const r = role.toLowerCase().trim();
    if (r === "a" || r === "link") return ["link", "a", "button"];
    if (r === "input" || r === "textbox" || r === "searchbox") return ["textbox", "searchbox", "combobox", "input"];
    if (r === "button") return ["button", "link"];
    if (r === "heading") return ["heading"];
    return [r];
}

function ambiguousSelectorTarget(selector: string, count: number): ResolvedStepTarget {
    return {
        backendNodeId: 0,
        matched: { selector },
        axInfo: {},
        ambiguous: true,
        candidateCount: count,
        confidence: 0,
        recoveryHint: "Narrow the selector or provide a semantic target fingerprint.",
    };
}

async function resolveSelectorTarget(
    target: chrome.debugger.Debuggee,
    selector: string,
): Promise<ResolvedStepTarget | null> {
    const docResult = await sendCommand(target, "DOM.getDocument", { depth: 0 });
    const rootNodeId = docResult?.root?.nodeId;
    if (!rootNodeId) return null;
    const queryResult = await sendCommand(target, "DOM.querySelectorAll", { nodeId: rootNodeId, selector });
    const nodeIds = queryResult?.nodeIds ?? [];
    if (nodeIds.length === 0) return null;
    if (nodeIds.length > 1) return ambiguousSelectorTarget(selector, nodeIds.length);

    const nodeId = nodeIds[0];
    if (nodeId == null) return null;
    const describeResult = await sendCommand(target, "DOM.describeNode", { nodeId });
    const backendNodeId = describeResult?.node?.backendNodeId;
    if (!backendNodeId) return null;
    const axInfo = await getAxInfoForNode(target, backendNodeId);
    return { backendNodeId, matched: { selector }, axInfo, drift: "EXACT", confidence: 1 };
}

function fuzzyConfidence(expected: string, actual: string): number {
    if (!expected || !actual) return 0;
    return Math.min(expected.length, actual.length) / Math.max(expected.length, actual.length);
}

/** Resolves step target against live page accessibility tree or CSS selector. */
async function resolveStepTarget(target: chrome.debugger.Debuggee, step: FlowStep): Promise<ResolvedStepTarget | null> {
    const hasSpecificSelector = Boolean(step.selector && (step.selector.includes("#") || step.selector.includes("[")));

    // 1. If selector has specific ID or attribute, try DOM query first.
    if (hasSpecificSelector && step.selector) {
        try {
            const resolved = await resolveSelectorTarget(target, step.selector);
            if (resolved && (!resolved.ambiguous || !step.name)) return resolved;
        } catch {}
    }

    // 2. Try matching via Accessibility Tree (role + accessible name)
    if (step.name) {
        try {
            const axTreeResult = await sendCommand(target, "Accessibility.getFullAXTree", {});
            const nodes = axTreeResult?.nodes || [];
            const allowedRoles = normalizeRole(step.role);
            const targetNameLower = step.name.toLowerCase().trim();

            let candidates = nodes.filter((n) => {
                if (n.backendDOMNodeId == null || !n.name?.value) return false;
                const nodeRole = n.role?.value?.toLowerCase();
                const roleMatches = allowedRoles.length === 0 || (nodeRole && allowedRoles.includes(nodeRole));
                const nameMatches = n.name.value.trim() === step.name?.trim();
                return roleMatches && nameMatches;
            });

            let drift: DriftKind = "EXACT";
            if (candidates.length === 0) {
                // Substring / fuzzy match is reported as a repair, not silently treated as exact.
                drift = "SEMANTIC_REPAIR";
                candidates = nodes.filter((n) => {
                    if (n.backendDOMNodeId == null || !n.name?.value) return false;
                    const nodeRole = n.role?.value?.toLowerCase();
                    const roleMatches = allowedRoles.length === 0 || (nodeRole && allowedRoles.includes(nodeRole));
                    const nodeNameLower = n.name.value.toLowerCase().trim();
                    return (
                        roleMatches &&
                        (nodeNameLower.includes(targetNameLower) || targetNameLower.includes(nodeNameLower))
                    );
                });
            }

            const selection = selectUniqueCandidate(candidates, (candidate) => candidate.backendDOMNodeId);
            if (selection.kind === "ambiguous") {
                return {
                    backendNodeId: 0,
                    matched: { role: step.role, name: step.name },
                    axInfo: { role: step.role, name: step.name },
                    ambiguous: true,
                    candidateCount: selection.count,
                    confidence: 0,
                    recoveryHint: "Narrow the role/name or add a durable selector hint.",
                    drift,
                };
            }
            if (selection.kind === "matched") {
                const actualName = String(selection.value.name?.value ?? "").trim();
                const confidence = drift === "EXACT" ? 1 : fuzzyConfidence(targetNameLower, actualName.toLowerCase());
                const resolvedDrift: DriftKind = confidence < 0.5 ? "TARGET_DRIFT" : drift;
                return {
                    backendNodeId: selection.value.backendDOMNodeId!,
                    matched: { role: step.role, name: step.name },
                    axInfo: { role: step.role, name: step.name },
                    confidence,
                    ...(resolvedDrift === "SEMANTIC_REPAIR"
                        ? { recoveryHint: "Review the repaired target and save a refreshed descriptor if intentional." }
                        : {}),
                    ...(resolvedDrift === "TARGET_DRIFT"
                        ? { recoveryHint: "Refresh the snapshot and confirm the intended target before retrying." }
                        : {}),
                    drift: resolvedDrift,
                };
            }
        } catch {}
    }

    // 3. Fallback to generic selector if not already matched.
    if (!hasSpecificSelector && step.selector) {
        try {
            return await resolveSelectorTarget(target, step.selector);
        } catch {}
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

type TransitionCheck = { ok: true } | { ok: false; reason: string };

function escapeRegexPart(part: string): string {
    let escaped = "";
    for (const character of part) {
        if ("\\^$+.()|[]{}".includes(character)) escaped += "\\";
        escaped += character;
    }
    return escaped;
}

function matchesUrlPattern(url: string, pattern: string): boolean {
    const expression = new RegExp(`^${pattern.split("*").map(escapeRegexPart).join(".*")}$`);
    return expression.test(url);
}

async function getCurrentFrameUrl(target: chrome.debugger.Debuggee): Promise<string | undefined> {
    try {
        const frameTree = await sendCommand(target, "Page.getFrameTree");
        return frameTree?.frameTree?.frame?.url;
    } catch {
        return undefined;
    }
}

async function verifyExpectedTransition(
    target: chrome.debugger.Debuggee,
    expected: ExpectedTransition,
    beforeUrl?: string,
): Promise<TransitionCheck> {
    if (expected.kind === "none") return { ok: true };

    try {
        if (expected.kind === "navigation") {
            const afterUrl = await getCurrentFrameUrl(target);
            if (!afterUrl || afterUrl === beforeUrl) return { ok: false, reason: "navigation was not observed" };
            if (expected.urlPattern && !matchesUrlPattern(afterUrl, expected.urlPattern)) {
                return { ok: false, reason: `navigation ended at an unexpected URL (${afterUrl})` };
            }
            return { ok: true };
        }

        if (expected.kind === "text") {
            const contains = expected.contains?.trim();
            if (!contains) return { ok: false, reason: "text expectation has no contains value" };
            const result = await sendCommand(target, "Runtime.evaluate", {
                expression: `document.body?.innerText?.includes(${JSON.stringify(contains)}) === true`,
                returnByValue: true,
            });
            return result?.result?.value === true
                ? { ok: true }
                : { ok: false, reason: `page text did not contain ${JSON.stringify(contains)}` };
        }

        if (expected.kind === "state") {
            const selector = expected.selector?.trim();
            if (!selector) return { ok: false, reason: "state expectation has no selector" };
            const selectorExpression = JSON.stringify(selector);
            const attributeExpression = JSON.stringify(expected.attribute?.trim() ?? "");
            const valueExpression = JSON.stringify(expected.value ?? "");
            const checkExpression = expected.attribute
                ? expected.value !== undefined
                    ? `element?.getAttribute(${attributeExpression}) === ${valueExpression}`
                    : `element?.hasAttribute(${attributeExpression}) === true`
                : "element != null";
            const result = await sendCommand(target, "Runtime.evaluate", {
                expression: `(() => { const element = document.querySelector(${selectorExpression}); return ${checkExpression}; })()`,
                returnByValue: true,
            });
            return result?.result?.value === true
                ? { ok: true }
                : { ok: false, reason: `state expectation did not match ${selector}` };
        }
    } catch {
        return { ok: false, reason: "expected transition could not be evaluated" };
    }

    return { ok: false, reason: "unsupported expected transition" };
}

function isSensitiveStep(step: FlowStep): boolean {
    const targetHint = `${step.role ?? ""} ${step.name ?? ""} ${step.selector ?? ""}`;
    return /password|passcode|pin|token|secret|credential|authorization|cookie/i.test(targetHint);
}

function reportFlowFailure(phase: FailureEvent["phase"], code: string, message: string, sensitive: boolean): void {
    emitFailureEvent({
        phase,
        code,
        message: sensitive ? "Sensitive flow step failed." : message,
    });
}

function reportFlowAssertion(expression: string, result: "passed" | "failed", sensitive: boolean): void {
    emitAssertionEvent({
        expression: sensitive ? "Sensitive assertion" : expression,
        result,
        sensitive,
    });
}

/** Executes sequential action steps on the page, halting immediately on any failure or unconfirmed risk. */
export async function runFlowSteps(
    target: chrome.debugger.Debuggee,
    steps: readonly (FlowStep | FlowStepV2)[],
    opts: { captureEachStep: boolean; returnSnapshot?: boolean },
): Promise<FlowReport> {
    if (steps.length > MAX_FLOW_STEPS) {
        reportFlowFailure("resolve", "too_many_steps", `Flow exceeded the ${MAX_FLOW_STEPS}-step limit.`, false);
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
        const rawStep = steps[i]!;
        const step = normalizeFlowStep(rawStep);
        const expected = "expected" in rawStep ? rawStep.expected : undefined;
        const policy = "policy" in rawStep ? rawStep.policy : undefined;
        const needsTarget =
            step.action !== "scroll" &&
            step.action !== "drag" &&
            !(step.action === "press_key" && !step.role && !step.selector);

        let resolved: ResolvedStepTarget | null = null;

        if (needsTarget) {
            const timeoutMs =
                step.timeoutMs ?? (step.action === "wait_for" ? WAIT_FOR_DEFAULT_TIMEOUT_MS : DEFAULT_STEP_TIMEOUT_MS);
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
                    error: "not_found",
                });
                reportFlowFailure(
                    "resolve",
                    "target_not_found",
                    `Step ${i} (${step.action}) found no element matching ${describeStepTarget(step)}.`,
                    isSensitiveStep(step),
                );
                return stop(
                    i,
                    "not_found",
                    `Step ${i} (${step.action}) found no element matching ${describeStepTarget(step)} after ${timeoutMs}ms. Stopped before continuing — take a fresh browser_inspect({action:"snapshot"}) and correct this step.`,
                );
            }

            if (resolved.ambiguous) {
                const candidateCount = resolved.candidateCount ?? 2;
                results.push({
                    index: i,
                    action: step.action,
                    matched: resolved.matched,
                    ambiguous: true,
                    confidence: resolved.confidence,
                    recoveryHint: resolved.recoveryHint,
                    drift: resolved.drift,
                    success: false,
                    error: "ambiguous_target",
                });
                reportFlowFailure(
                    "resolve",
                    "ambiguous_target",
                    `Step ${i} (${step.action}) matched ${candidateCount} elements.`,
                    isSensitiveStep(step),
                );
                return stop(
                    i,
                    "ambiguous",
                    `Step ${i} (${step.action}) matched ${candidateCount} elements for ${describeStepTarget(step)}. Stopped without acting — narrow the selector or add more semantic context.`,
                );
            }

            if (resolved.drift === "TARGET_DRIFT") {
                results.push({
                    index: i,
                    action: step.action,
                    matched: resolved.matched,
                    ambiguous: resolved.ambiguous,
                    confidence: resolved.confidence,
                    recoveryHint: resolved.recoveryHint,
                    drift: resolved.drift,
                    success: false,
                    error: "target_drift",
                });
                reportFlowFailure(
                    "resolve",
                    "target_drift",
                    `Step ${i} (${step.action}) resolved with low confidence.`,
                    isSensitiveStep(step),
                );
                return stop(
                    i,
                    "target_drift",
                    `Step ${i} (${step.action}) found a low-confidence target repair for ${describeStepTarget(step)}. ${resolved.recoveryHint ?? "Refresh the snapshot and confirm the target before retrying."}`,
                );
            }

            if (isRiskyTarget(resolved.axInfo) && !step.confirmRisky) {
                results.push({
                    index: i,
                    action: step.action,
                    matched: resolved.matched,
                    ambiguous: resolved.ambiguous,
                    confidence: resolved.confidence,
                    recoveryHint: resolved.recoveryHint,
                    drift: resolved.drift,
                    success: false,
                    error: "risky_action_blocked",
                });
                const blockedActionId = `a${crypto.randomUUID()}`;
                const blockedAt = Date.now();
                const blockedTarget = toFlowTargetDescriptor(step);
                emitActionLifecycle({
                    type: "action_started",
                    actionId: blockedActionId,
                    ts: blockedAt,
                    action: step.action,
                    tabId: target.tabId,
                    ...(blockedTarget ? { semanticTarget: blockedTarget } : {}),
                    sensitive: isSensitiveStep(step),
                });
                emitActionLifecycle({
                    type: "action_finished",
                    actionId: blockedActionId,
                    ts: Date.now(),
                    action: step.action,
                    tabId: target.tabId,
                    durationMs: Date.now() - blockedAt,
                    result: "blocked",
                    drift: resolved.drift,
                    sensitive: isSensitiveStep(step),
                });
                reportFlowFailure(
                    "risk",
                    "risky_action_blocked",
                    `Step ${i} (${step.action}) was blocked by the target-risk policy.`,
                    isSensitiveStep(step),
                );
                return stop(
                    i,
                    "risky_action_blocked",
                    `Step ${i} (${step.action}) targets ${describeStepTarget(step)} (${resolved.axInfo.role ?? "element"} "${resolved.axInfo.name ?? ""}"), which looks potentially destructive/irreversible. Confirm this is intended with your user, then re-run with steps[${i}].confirmRisky:true.`,
                );
            }
        }

        const actionId = `a${crypto.randomUUID()}`;
        const actionStartedAt = Date.now();
        const semanticTarget = toFlowTargetDescriptor(step);
        const sensitive = isSensitiveStep(step);
        const beforeUrl = expected?.kind === "navigation" ? await getCurrentFrameUrl(target) : undefined;
        emitActionLifecycle({
            type: "action_started",
            actionId,
            ts: actionStartedAt,
            action: step.action,
            tabId: target.tabId,
            ...(semanticTarget ? { semanticTarget } : {}),
            sensitive,
        });

        let actionResult: ActionResult;
        try {
            switch (step.action) {
                case "click":
                    actionResult = await performClick(target, resolved!.backendNodeId, { fast: true });
                    break;
                case "type":
                    actionResult = await performType(target, resolved?.backendNodeId, step.text ?? "", { fast: true });
                    break;
                case "press_key":
                    actionResult = await performPressKey(target, step.key ?? "", resolved?.backendNodeId, {
                        fast: true,
                    });
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
        } catch (error) {
            actionResult = { error: error instanceof Error ? error.message : String(error) };
        }

        let settleReason = actionResult.settleReason;
        if (step.action === "wait_for") {
            settleReason = (await waitForStableDom(target, { quietMs: 150, timeoutMs: 1500 })).reason;
            if (settleReason === "timeout" && "success" in actionResult) {
                actionResult = { error: "Wait step did not reach DOM quiet before the settle timeout" };
            }
        }
        if (settleReason === "timeout" && "success" in actionResult) {
            actionResult = { error: "Action did not reach DOM quiet before the settle timeout" };
        }

        let drift = resolved?.drift;
        let behaviorDrift = false;
        if ("success" in actionResult && expected && expected.kind !== "none") {
            const transition = await verifyExpectedTransition(target, expected, beforeUrl);
            reportFlowAssertion(`expected ${expected.kind} transition`, transition.ok ? "passed" : "failed", sensitive);
            if (!transition.ok) {
                behaviorDrift = true;
                drift = "BEHAVIOR_DRIFT";
                actionResult = { error: `Expected transition failed: ${transition.reason}` };
            }
        }

        const success = "success" in actionResult;
        if (step.action === "assert_text") {
            reportFlowAssertion(
                `text contains ${JSON.stringify(step.contains ?? "")}`,
                success ? "passed" : "failed",
                sensitive,
            );
        }
        const stepErrorMessage = "error" in actionResult ? actionResult.error : undefined;
        emitActionLifecycle({
            type: "action_finished",
            actionId,
            ts: Date.now(),
            action: step.action,
            tabId: target.tabId,
            durationMs: Date.now() - actionStartedAt,
            result: success ? "succeeded" : "failed",
            ...(drift ? { drift } : {}),
            sensitive,
        });
        results.push({
            index: i,
            action: step.action,
            matched: resolved?.matched,
            ambiguous: resolved?.ambiguous,
            ...(resolved?.confidence != null ? { confidence: resolved.confidence } : {}),
            ...(resolved?.recoveryHint ? { recoveryHint: resolved.recoveryHint } : {}),
            ...(drift ? { drift } : {}),
            ...(settleReason ? { settleReason } : {}),
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
            reportFlowFailure(
                behaviorDrift ? "assert" : settleReason === "timeout" ? "settle" : "action",
                behaviorDrift ? "behavior_drift" : settleReason === "timeout" ? "settle_timeout" : "action_failed",
                stepErrorMessage ?? `Step ${i} (${step.action}) failed.`,
                sensitive,
            );
            if (behaviorDrift && policy?.onDrift === "report") continue;
            return stop(
                i,
                behaviorDrift ? "behavior_drift" : step.action === "assert_text" ? "assert_failed" : "action_failed",
                behaviorDrift
                    ? `Step ${i} (${step.action}) completed but behavior drifted: ${stepErrorMessage}`
                    : `Step ${i} (${step.action}) failed: ${stepErrorMessage}`,
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

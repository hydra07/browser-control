/**
 * Dispatches relayed BrowserCommand to its respective handler.
 * Manages tab resolution, security boundaries, and CDP execution contexts.
 */
import type { BrowserCommand, FlowAction } from "@browsercontrol/shared";
import { getSettings, getSettingsSync } from "../../configs/settings.js";
import { evalOnPage, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { emitActionLifecycle } from "../actions/events.js";
import {
    getAxInfoForNode,
    isRiskyTarget,
    performClick,
    performDrag,
    performPressKey,
    performScroll,
    performType,
} from "../actions/index.js";
import {
    handleAnalyzeHar,
    handleDebugLayout,
    handleEmulate,
    handleInspectMemory,
    handleInspectProcess,
} from "../devtools/index.js";
import { emitFailureEvent, queryEvidence, setEvidenceSession } from "../evidence/index.js";
import { runFlowSteps } from "../flow/index.js";
import { inspectElement } from "../inspect/index.js";
import { clearBlockedRequests, setSandbox } from "../interceptor/index.js";
import { clearNetworkRequests, getNetworkRequestDetail, listNetworkRequests } from "../network/index.js";
import { NAVIGATE_ICON_SVG, showPillCaption } from "../overlay/index.js";
import { handlePeekScreenCommand } from "../peek/index.js";
import { handleFindCommand, handleReadingModeCommand, handleSelectContentCommand } from "../read/index.js";
import { flowRecorder } from "../recorder/index.js";
import { captureScreenshot } from "../screenshot/index.js";
import {
    handleQueryRegionCommand,
    handleSemanticSnapshotCommand,
    handleSnapshotCommand,
    handleVisualSnapshotCommand,
    resolveSemanticRef,
} from "../snapshot/index.js";
import { addTabToWorkspaceGroup, handleListTabsCommand, handleSwitchTabCommand } from "../tabs/index.js";
import { waitForStableDom } from "../wait/index.js";
import { NAVIGATE_LOAD_TIMEOUT_MS } from "./constants.js";
import type { DispatchCtx } from "./types.js";

export type { DispatchCtx } from "./types.js";

/** Checks if a URL allows attaching the Chrome debugger. */
function isAttachableUrl(url: string | undefined): boolean {
    if (!url) return false;
    return !/^(chrome|chrome-extension|edge|devtools|chrome-untrusted|chrome-search|about):/i.test(url);
}

interface ActionLifecycleOptions {
    tabId?: number;
    targetRef?: string;
    lifecycleResult?: "blocked";
}

async function withActionLifecycle<T extends object>(
    action: FlowAction,
    sensitive: boolean,
    operation: () => Promise<T>,
    options: ActionLifecycleOptions = {},
): Promise<T> {
    const actionId = `a${crypto.randomUUID()}`;
    const startedAt = Date.now();
    emitActionLifecycle({
        type: "action_started",
        actionId,
        ts: startedAt,
        action,
        ...(options.tabId != null ? { tabId: options.tabId } : {}),
        ...(options.targetRef ? { targetRef: options.targetRef } : {}),
        sensitive,
    });
    try {
        const result = await operation();
        const succeeded = "success" in result;
        if (!succeeded) {
            emitFailureEvent({
                phase: options.lifecycleResult === "blocked" ? "risk" : "action",
                code: options.lifecycleResult === "blocked" ? "risky_action_blocked" : "action_failed",
                message: sensitive ? "Sensitive action failed." : "Standalone action failed.",
            });
        }
        emitActionLifecycle({
            type: "action_finished",
            actionId,
            ts: Date.now(),
            action,
            ...(options.tabId != null ? { tabId: options.tabId } : {}),
            ...(options.targetRef ? { targetRef: options.targetRef } : {}),
            durationMs: Date.now() - startedAt,
            result: options.lifecycleResult ?? (succeeded ? "succeeded" : "failed"),
            sensitive,
        });
        return result;
    } catch (error) {
        emitFailureEvent({
            phase: "action",
            code: "action_exception",
            message: sensitive ? "Sensitive action failed." : "Standalone action raised an exception.",
        });
        emitActionLifecycle({
            type: "action_finished",
            actionId,
            ts: Date.now(),
            action,
            ...(options.tabId != null ? { tabId: options.tabId } : {}),
            ...(options.targetRef ? { targetRef: options.targetRef } : {}),
            durationMs: Date.now() - startedAt,
            result: "failed",
            sensitive,
        });
        throw error;
    }
}

async function getRiskBlock(
    target: chrome.debugger.Debuggee,
    backendNodeId: number | undefined,
    confirmRisky: boolean | undefined,
): Promise<Record<string, unknown> | null> {
    if (backendNodeId == null || confirmRisky) return null;
    const axInfo = await getAxInfoForNode(target, backendNodeId).catch(() => null);
    if (!axInfo || !isRiskyTarget(axInfo)) return null;
    return {
        error: "risky_action_blocked",
        hint: `This target (${axInfo.role ?? "element"} "${axInfo.name ?? ""}") looks potentially destructive or irreversible. Confirm it with the user, then retry with confirmRisky:true.`,
    };
}

/** Finds an attachable tab in the most recently focused window or across tabs. */
async function findAttachableFallbackTab(): Promise<number | null> {
    try {
        const [currentActive] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        if (currentActive?.id != null && isAttachableUrl(currentActive.url)) {
            return currentActive.id;
        }
        const [activeTab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true,
        });
        if (activeTab?.id != null && isAttachableUrl(activeTab.url)) {
            return activeTab.id;
        }
    } catch {}
    const allTabs = await chrome.tabs.query({});
    const candidates = allTabs.filter((t) => t.id != null && isAttachableUrl(t.url));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return candidates[0].id ?? null;
}

async function handleNavigate(
    url: string,
    opts: { tabId?: number; newTab?: boolean; background?: boolean },
    ctx: DispatchCtx,
): Promise<Record<string, unknown>> {
    clearNetworkRequests();

    let windowId: number | undefined;
    let tabId: number;
    let reuseExistingTab: boolean;
    const active = !opts.background;

    if (opts.tabId != null && opts.tabId > 0) {
        let tabFound = false;
        try {
            await chrome.tabs.get(opts.tabId);
            tabFound = true;
        } catch {
            console.log(`Requested tabId ${opts.tabId} does not exist — falling back.`);
        }
        if (tabFound) {
            tabId = opts.tabId;
            reuseExistingTab = true;
        } else {
            const lastActiveTabId = ctx.getLastActiveTabId();
            let existingTabIsValid = false;
            if (lastActiveTabId) {
                try {
                    await chrome.tabs.get(lastActiveTabId);
                    existingTabIsValid = true;
                } catch {
                    console.log(`Stale lastActiveTabId ${lastActiveTabId} (tab no longer exists).`);
                }
            }
            if (existingTabIsValid) {
                tabId = lastActiveTabId!;
                reuseExistingTab = true;
            } else {
                const fallbackTab = await findAttachableFallbackTab();
                if (fallbackTab != null) {
                    tabId = fallbackTab;
                    reuseExistingTab = true;
                } else {
                    const newTab = await chrome.tabs.create({ url, active });
                    tabId = newTab.id!;
                    windowId = newTab.windowId;
                    reuseExistingTab = false;
                }
            }
        }
    } else if (opts.newTab) {
        const newTab = await chrome.tabs.create({ url, active });
        tabId = newTab.id!;
        windowId = newTab.windowId;
        reuseExistingTab = false;
    } else {
        const lastActiveTabId = ctx.getLastActiveTabId();
        let existingTabIsValid = false;
        if (lastActiveTabId) {
            try {
                await chrome.tabs.get(lastActiveTabId);
                existingTabIsValid = true;
            } catch {
                console.log(`Stale lastActiveTabId ${lastActiveTabId} (tab no longer exists) — creating a new tab.`);
            }
        }
        if (existingTabIsValid) {
            tabId = lastActiveTabId!;
            reuseExistingTab = true;
        } else {
            const newTab = await chrome.tabs.create({ url, active });
            tabId = newTab.id!;
            windowId = newTab.windowId;
            reuseExistingTab = false;
        }
    }

    if (reuseExistingTab) {
        const updatedTab = await chrome.tabs.update(tabId, { url, active });
        windowId = updatedTab?.windowId;
    }
    if (!opts.background) ctx.setLastActiveTabId(tabId);

    if (windowId !== undefined && !opts.background) {
        chrome.windows.update(windowId, { focused: true }, () => {
            if (chrome.runtime.lastError) console.log("Could not focus window:", chrome.runtime.lastError.message);
        });
    }

    await addTabToWorkspaceGroup(tabId);

    // Wait for the browser-level load event, then let the page's own JS
    // settle (SPA hydration, redirects) instead of guessing with a sleep.
    // Bounded and always cleaned up — see NAVIGATE_LOAD_TIMEOUT_MS above.
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, NAVIGATE_LOAD_TIMEOUT_MS);
        function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo) {
            if (updatedTabId === tabId && info.status === "complete") {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });

    await ctx.attachDebuggerIfNeeded(tabId);
    await waitForStableDom({ tabId }, { timeoutMs: 3000 });

    if (!opts.background) {
        let hostname = url;
        try {
            hostname = new URL(url).hostname || url;
        } catch {}
        void evalOnPage(
            { tabId },
            `(${showPillCaption.toString()})(${JSON.stringify(NAVIGATE_ICON_SVG)}, ${JSON.stringify(`Navigated to ${hostname}`)}, ${JSON.stringify("#6ee7b7")}, ${JSON.stringify("#34d399")}, false)`,
        );
    }

    return { success: true, message: `Navigated to ${url}`, tabId };
}

export async function dispatchCommand(
    data: BrowserCommand & { id?: string },
    ctx: DispatchCtx,
): Promise<Record<string, unknown>> {
    const cmd = data.cmd;
    const effectiveTabId = typeof data.tabId === "number" && data.tabId > 0 ? data.tabId : undefined;
    if (data.sessionId) setEvidenceSession(data.sessionId);

    if (cmd === "navigate") {
        return await handleNavigate(
            data.url,
            {
                tabId: effectiveTabId,
                newTab: data.newTab,
                background: data.background,
            },
            ctx,
        );
    }

    if (cmd === "peek_screen") {
        return await handlePeekScreenCommand({
            tabId: effectiveTabId,
            screenshot: data.screenshot,
            maxChars: data.maxChars,
            includeSelection: data.includeSelection,
        });
    }

    if (cmd === "list_tabs") {
        return await handleListTabsCommand(ctx.getLastActiveTabId(), { scope: data.scope });
    }
    if (cmd === "switch_tab") {
        if (!effectiveTabId) {
            return {
                error: `Invalid or missing tabId: ${data.tabId}`,
                hint: 'Call browser_session({action:"list_tabs"}) to see currently open tabs and their real tab IDs.',
            };
        }
        const result = await handleSwitchTabCommand(effectiveTabId);
        if ("success" in result) ctx.setLastActiveTabId(result.newActiveTabId);
        return result;
    }

    if (cmd === "evidence") {
        return queryEvidence(data.sessionId ?? "extension-session", data.mode, data.after, data.limit, data.profile);
    }

    if (cmd === "close_tab") {
        if (!effectiveTabId) {
            return {
                error: `Invalid or missing tabId: ${data.tabId}`,
                hint: 'Call browser_session({action:"list_tabs"}) to see currently open tabs and their real tab IDs.',
            };
        }
        try {
            await chrome.tabs.remove(effectiveTabId);
            return { success: true, message: `Closed tab ${effectiveTabId}` };
        } catch (e) {
            return {
                error: `Failed to close tab ${effectiveTabId}`,
                hint: errorMessage(e),
            };
        }
    }

    let targetTabId: number | null = null;
    if (effectiveTabId) {
        try {
            await chrome.tabs.get(effectiveTabId);
            targetTabId = effectiveTabId;
        } catch {
            console.log(`Target tabId ${effectiveTabId} not found; falling back to active tab.`);
        }
    }
    if (!targetTabId) {
        const lastActive = ctx.getLastActiveTabId();
        if (lastActive) {
            try {
                await chrome.tabs.get(lastActive);
                targetTabId = lastActive;
            } catch {}
        }
    }
    if (!targetTabId) {
        const fallbackTab = await findAttachableFallbackTab();
        if (fallbackTab != null) {
            targetTabId = fallbackTab;
            ctx.setLastActiveTabId(targetTabId);
        }
    }
    if (!targetTabId) {
        return {
            error: "No active session. Call navigate first.",
            hint: "No tabId was given and no attachable browser tab could be found to fall back to (chrome://, the extension's own pages, and similar internal URLs can't be debugged). Open a normal web page tab, or call browser_navigate first.",
        };
    }

    // Safety Guard: Ensure tab belongs to the AI Workspace group (auto-group if running interactive flow)
    if (["click", "type", "press_key", "drag", "run_flow", "explore_flow"].includes(cmd)) {
        try {
            const tab = await chrome.tabs.get(targetTabId);
            const { tabGroupName } = await getSettings();
            let inWorkspace = false;
            if (tab.groupId != null && tab.groupId > 0) {
                const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
                if (group && group.title === tabGroupName) inWorkspace = true;
            }
            if (!inWorkspace) {
                await addTabToWorkspaceGroup(targetTabId);
            }
        } catch {}
    }
    await ctx.attachDebuggerIfNeeded(targetTabId);
    const target = { tabId: targetTabId };
    const animated = getSettingsSync().animationsEnabled;

    if (cmd === "snapshot") {
        if (data.semantic) return await handleSemanticSnapshotCommand(target);
        return await handleSnapshotCommand(target, {
            compact: data.compact,
            format: data.format,
        });
    }

    if (cmd === "query_region") return await handleQueryRegionCommand(target, data.selector);

    if (cmd === "visual_snapshot") return await handleVisualSnapshotCommand(target);

    if (cmd === "reading_mode") return await handleReadingModeCommand(target, data.maxChars);

    if (cmd === "find") return await handleFindCommand(target, data.query, data.limit);

    if (cmd === "select_content")
        return await handleSelectContentCommand(target, {
            selector: data.selector,
            nodeId: data.nodeId,
            maxChars: data.maxChars,
            maxMatches: data.maxMatches,
        });

    if (cmd === "click") {
        const nodeId = data.ref ? resolveSemanticRef(targetTabId, data.ref, data.documentId) : data.nodeId;
        if (nodeId == null)
            return {
                error: data.ref ? "Stale or invalid semantic ref" : "Missing nodeId",
                hint: data.ref
                    ? "Take a fresh semantic snapshot and pass its ref together with the returned documentId."
                    : "Call snapshot first and pass one of the returned node ids.",
            };
        const riskBlock = await getRiskBlock(target, nodeId, data.confirmRisky);
        if (riskBlock) {
            return await withActionLifecycle("click", false, () => Promise.resolve(riskBlock), {
                tabId: targetTabId,
                targetRef: data.ref,
                lifecycleResult: "blocked",
            });
        }
        return await withActionLifecycle("click", false, () => performClick(target, nodeId, { fast: !animated }), {
            tabId: targetTabId,
            targetRef: data.ref,
        });
    }

    if (cmd === "type") {
        if (!data.text) return { error: "Missing text" };
        const nodeId = data.ref
            ? (resolveSemanticRef(targetTabId, data.ref, data.documentId) ?? undefined)
            : data.nodeId;
        if (data.ref && nodeId == null) {
            return {
                error: "Stale or invalid semantic ref",
                hint: "Take a fresh semantic snapshot and pass its ref together with the returned documentId.",
            };
        }
        const riskBlock = await getRiskBlock(target, nodeId, data.confirmRisky);
        if (riskBlock) {
            return await withActionLifecycle("type", true, () => Promise.resolve(riskBlock), {
                tabId: targetTabId,
                targetRef: data.ref,
                lifecycleResult: "blocked",
            });
        }
        return await withActionLifecycle(
            "type",
            true,
            () =>
                performType(target, nodeId, data.text, {
                    fast: !animated,
                }),
            { tabId: targetTabId, targetRef: data.ref },
        );
    }

    if (cmd === "press_key") {
        const nodeId = data.ref
            ? (resolveSemanticRef(targetTabId, data.ref, data.documentId) ?? undefined)
            : data.nodeId;
        if (data.ref && nodeId == null) {
            return {
                error: "Stale or invalid semantic ref",
                hint: "Take a fresh semantic snapshot and pass its ref together with the returned documentId.",
            };
        }
        const riskBlock = await getRiskBlock(target, nodeId, data.confirmRisky);
        if (riskBlock) {
            return await withActionLifecycle("press_key", false, () => Promise.resolve(riskBlock), {
                tabId: targetTabId,
                targetRef: data.ref,
                lifecycleResult: "blocked",
            });
        }
        return await withActionLifecycle(
            "press_key",
            false,
            () =>
                performPressKey(target, data.key, nodeId, {
                    fast: !animated,
                }),
            { tabId: targetTabId, targetRef: data.ref },
        );
    }

    if (cmd === "run_flow" || cmd === "explore_flow") {
        if (!Array.isArray(data.steps) || data.steps.length === 0) {
            return {
                error: "Missing steps",
                hint: "Pass a non-empty array of flow steps, e.g. [{action:'click', role:'button', name:'Login'}].",
            };
        }
        // Auto-navigate to target domain if not currently matching
        if (data.domain) {
            let currentHost: string | undefined;
            try {
                currentHost = new URL((await chrome.tabs.get(targetTabId)).url ?? "").hostname;
            } catch {}
            if (currentHost !== data.domain) {
                const navResult = await handleNavigate(
                    `https://${data.domain}`,
                    {
                        tabId: targetTabId,
                    },
                    ctx,
                );
                if ("error" in navResult) return navResult;
            }
        }
        return await runFlowSteps(target, data.steps, {
            captureEachStep: cmd === "explore_flow",
            returnSnapshot: data.returnSnapshot,
        });
    }

    if (cmd === "scroll") {
        return await withActionLifecycle(
            "scroll",
            false,
            () =>
                performScroll(target, data.deltaX || 0, data.deltaY || 0, {
                    fast: !animated,
                }),
            { tabId: targetTabId },
        );
    }

    if (cmd === "drag") {
        return await withActionLifecycle(
            "drag",
            false,
            () =>
                performDrag(target, data.fromX, data.fromY, data.toX, data.toY, {
                    fast: !animated,
                    points: data.points,
                    shape: data.shape,
                    shapeParams: data.shapeParams,
                    path: data.path,
                    stepsCount: data.stepsCount,
                    easing: data.easing,
                    button: data.button,
                }),
            { tabId: targetTabId },
        );
    }

    if (cmd === "screenshot") {
        return await captureScreenshot(target, {
            format: data.format === "png" ? "png" : "jpeg",
            quality: data.quality,
            fullPage: data.fullPage,
        });
    }

    if (cmd === "inspect_element") {
        const nodeId = data.ref ? resolveSemanticRef(targetTabId, data.ref, data.documentId) : data.nodeId;
        if (nodeId == null)
            return {
                error: data.ref ? "Stale or invalid semantic ref" : "Missing nodeId",
                hint: data.ref
                    ? "Take a fresh semantic snapshot and pass its ref together with the returned documentId."
                    : "Call snapshot or visual_snapshot first and pass one of the returned node ids.",
            };
        return await inspectElement(target, nodeId);
    }

    if (cmd === "network_requests") {
        return {
            requests: listNetworkRequests({
                resourceTypes: data.resourceTypes,
                filter: data.filter,
                limit: data.limit,
            }),
        };
    }

    if (cmd === "network_request_detail") {
        if (!data.requestId)
            return {
                error: "Missing requestId",
                hint: "Call network_requests first and pass one of the returned request ids.",
            };
        return await getNetworkRequestDetail(target, data.requestId, data.includeBody === true);
    }

    if (cmd === "network_clear") {
        clearNetworkRequests();
        clearBlockedRequests();
        return { success: true, message: "Network log cleared." };
    }

    if (cmd === "dev_memory") {
        return await handleInspectMemory(target, { focus: data.focus });
    }

    if (cmd === "dev_process") {
        return await handleInspectProcess(target, { focus: data.focus });
    }

    if (cmd === "dev_har") {
        return await handleAnalyzeHar(target, { filter: data.filter, includeBodies: data.includeBodies });
    }

    if (cmd === "dev_layout") {
        const nodeId = data.ref
            ? (resolveSemanticRef(targetTabId, data.ref, data.documentId) ?? undefined)
            : data.nodeId;
        if (data.ref && nodeId == null) {
            return {
                error: "Stale or invalid semantic ref",
                hint: "Take a fresh semantic snapshot and pass its ref together with the returned documentId.",
            };
        }
        return await handleDebugLayout(target, { selector: data.selector, nodeId, focus: data.focus });
    }

    if (cmd === "dev_emulate") {
        return await handleEmulate(target, {
            device: data.device,
            network: data.network,
            cpuSlowdown: data.cpuSlowdown,
            touch: data.touch,
        });
    }

    if (cmd === "dev_sandbox") {
        const enable = data.mode !== "off";
        await setSandbox(target, targetTabId, enable);
        return enable
            ? {
                  success: true,
                  sandboxed: true,
                  message:
                      "Sandbox ON for this tab — every POST/PUT/PATCH/DELETE is intercepted, nothing reaches the real server. Answered with a real response this endpoint already produced this session if one exists, otherwise the submitted body echoed back. GET/HEAD pass through unaffected. inspect.network_requests marks intercepted calls with blocked:true.",
              }
            : {
                  success: true,
                  sandboxed: false,
                  message: "Sandbox OFF for this tab — requests now reach the real server again.",
              };
    }

    if (cmd === "start_flow_recording") {
        let recTabId = targetTabId;
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (activeTab?.id != null && isAttachableUrl(activeTab.url)) {
                recTabId = activeTab.id;
                ctx.setLastActiveTabId(recTabId);
            }
        } catch {}
        let dom = data.domain;
        if (!dom) {
            try {
                const tab = await chrome.tabs.get(recTabId);
                if (tab?.url) dom = new URL(tab.url).hostname;
            } catch {}
        }
        return await flowRecorder.start(recTabId, dom);
    }

    if (cmd === "stop_flow_recording") {
        return flowRecorder.stop();
    }

    if (cmd === "flow_recording_status") {
        return {
            isRecording: flowRecorder.isRecording(),
            stepCount: flowRecorder.getStepCount(),
            steps: flowRecorder.getRecordedSteps(),
        };
    }

    if (cmd === "evaluate") {
        const res = await sendCommand(target, "Runtime.evaluate", {
            expression: data.expression,
            returnByValue: true,
        });
        if (res?.exceptionDetails) {
            return {
                error: res.exceptionDetails.text,
                hint: "The expression threw. Check for syntax errors or references to elements that don't exist yet.",
            };
        }
        return { success: true, result: res?.result?.value };
    }

    return {
        error: `Unknown command: ${cmd}`,
        hint: `This loaded extension is v${ctx.extensionVersion}. If "${cmd}" is a real browsercontrol command, the extension in chrome://extensions is running an older build than the daemon — reload it there (MV3 extensions never pick up source changes automatically). Do not work around this by installing other automation libraries; it's a stale-extension issue, not a missing capability.`,
    };
}

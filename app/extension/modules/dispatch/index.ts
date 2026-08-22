/**
 * Dispatches relayed BrowserCommand to its respective handler.
 * Manages tab resolution, security boundaries, and CDP execution contexts.
 */
import type { BrowserCommand } from "@browsercontrol/shared";
import { getSettings, getSettingsSync } from "../../configs/settings.js";
import { evalOnPage, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { performClick, performDrag, performPressKey, performScroll, performType } from "../actions/index.js";
import {
    handleAnalyzeHar,
    handleDebugLayout,
    handleEmulate,
    handleInspectMemory,
    handleInspectProcess,
} from "../devtools/index.js";
import { runFlowSteps } from "../flow/index.js";
import { inspectElement } from "../inspect/index.js";
import { clearBlockedRequests, setSandbox } from "../interceptor/index.js";
import { clearNetworkRequests, getNetworkRequestDetail, listNetworkRequests } from "../network/index.js";
import { NAVIGATE_ICON_SVG, showPillCaption } from "../overlay/index.js";
import { handlePeekScreenCommand } from "../peek/index.js";
import { handleFindCommand, handleReadingModeCommand, handleSelectContentCommand } from "../read/index.js";
import { flowRecorder } from "../recorder/index.js";
import { captureScreenshot } from "../screenshot/index.js";
import { handleQueryRegionCommand, handleSnapshotCommand, handleVisualSnapshotCommand } from "../snapshot/index.js";
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

    if (opts.tabId != null) {
        try {
            await chrome.tabs.get(opts.tabId);
        } catch {
            return {
                error: `No tab with id ${opts.tabId}`,
                hint: 'Call browser_session({action:"list_tabs"}) to see currently open tabs, or omit tabId to open a new one.',
            };
        }
        tabId = opts.tabId;
        reuseExistingTab = true;
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

    if (cmd === "navigate") {
        return await handleNavigate(
            data.url,
            {
                tabId: data.tabId,
                newTab: data.newTab,
                background: data.background,
            },
            ctx,
        );
    }

    if (cmd === "peek_screen") {
        return await handlePeekScreenCommand({
            tabId: data.tabId,
            screenshot: data.screenshot,
            maxChars: data.maxChars,
            includeSelection: data.includeSelection,
        });
    }

    if (cmd === "list_tabs") {
        return await handleListTabsCommand(ctx.getLastActiveTabId(), { scope: data.scope });
    }
    if (cmd === "switch_tab") {
        const result = await handleSwitchTabCommand(data.tabId);
        if ("success" in result) ctx.setLastActiveTabId(result.newActiveTabId);
        return result;
    }

    if (cmd === "close_tab") {
        try {
            await chrome.tabs.remove(data.tabId);
            return { success: true, message: `Closed tab ${data.tabId}` };
        } catch (e) {
            return {
                error: `Failed to close tab ${data.tabId}`,
                hint: errorMessage(e),
            };
        }
    }

    let targetTabId = data.tabId ?? ctx.getLastActiveTabId();
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

    if (cmd === "snapshot")
        return await handleSnapshotCommand(target, {
            compact: data.compact,
            format: data.format,
        });

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
        if (!data.nodeId)
            return {
                error: "Missing nodeId",
                hint: "Call snapshot first and pass one of the returned node ids.",
            };
        return await performClick(target, data.nodeId, { fast: !animated });
    }

    if (cmd === "type") {
        if (!data.text) return { error: "Missing text" };
        return await performType(target, data.nodeId, data.text, {
            fast: !animated,
        });
    }

    if (cmd === "press_key") {
        return await performPressKey(target, data.key, data.nodeId, {
            fast: !animated,
        });
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
        return await performScroll(target, data.deltaX || 0, data.deltaY || 0, {
            fast: !animated,
        });
    }

    if (cmd === "drag") {
        return await performDrag(target, data.fromX, data.fromY, data.toX, data.toY, {
            fast: !animated,
            points: data.points,
            shape: data.shape,
            shapeParams: data.shapeParams,
            path: data.path,
            stepsCount: data.stepsCount,
            easing: data.easing,
            button: data.button,
        });
    }

    if (cmd === "screenshot") {
        return await captureScreenshot(target, {
            format: data.format === "png" ? "png" : "jpeg",
            quality: data.quality,
            fullPage: data.fullPage,
        });
    }

    if (cmd === "inspect_element") {
        if (!data.nodeId)
            return {
                error: "Missing nodeId",
                hint: "Call snapshot or visual_snapshot first and pass one of the returned node ids.",
            };
        return await inspectElement(target, data.nodeId);
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
        return await getNetworkRequestDetail(target, data.requestId);
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
        return await handleDebugLayout(target, { selector: data.selector, nodeId: data.nodeId, focus: data.focus });
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

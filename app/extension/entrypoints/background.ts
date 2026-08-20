import type { BrowserCommand } from "@browsercontrol/shared";
import { installDialogAutoHandler } from "../lib/dialog.js";
import {
    installNetworkCollector,
    listNetworkRequests,
    getNetworkRequestDetail,
    clearNetworkRequests,
} from "../lib/network.js";
import { sendCommand, errorMessage, evalOnPage } from "../lib/cdp.js";
import { captureScreenshot } from "../lib/screenshot.js";
import {
    installScreencastFrameRelay,
    startScreencastRelay,
    stopScreencastRelay,
} from "../lib/screencast.js";
import { showPillCaption } from "../lib/overlay.js";
import {
    performClick,
    performType,
    performPressKey,
    performScroll,
    performDrag,
} from "../lib/actions.js";
import { runFlowSteps } from "../lib/flow.js";
import {
    handleSnapshotCommand,
    handleQueryRegionCommand,
    handleVisualSnapshotCommand,
} from "../lib/snapshot.js";
import { inspectElement } from "../lib/inspect.js";
import {
    handleReadingModeCommand,
    handleFindCommand,
    handleSelectContentCommand,
} from "../lib/read.js";
import {
    installTabGroupBadge,
    handleListTabsCommand,
    handleSwitchTabCommand,
    addTabToWorkspaceGroup,
} from "../lib/tabs.js";
import { waitForStableDom } from "../lib/wait.js";

// WXT requires a `defineBackground` default export to recognize this file as
// the background entrypoint — everything below (previously plain top-level
// code) now runs inside its callback. Purely a wrapper: nothing here is
// re-timed or re-ordered, module evaluation still happens once, immediately,
// same as before.
export default defineBackground(() => {

// Single source of truth is manifest.json — bump its "version" whenever the
// extension changes, so a stale loaded build is easy to spot instead of
// failing mysteriously with "Unknown command".
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// lastActiveTabId is the default target for any command that omits tabId.
// attachedTabIds tracks CDP-attach state per tab (a Set, not one global
// flag) — what makes multi-tab work: two tabs can stay attached at once,
// so switch_tab doesn't have to detach one to attach the other.
let lastActiveTabId: number | null = null;
const attachedTabIds = new Set<number>();

// Chrome can detach a debugger session out from under us (DevTools infobar
// closed, OS debugger limit hit, ...) — clear the flag so the next command
// re-attaches instead of failing confusingly against a dead session.
chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) attachedTabIds.delete(source.tabId);
});

// A closed tab can't be re-attached to, or stay the default target.
chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabIds.delete(tabId);
    if (lastActiveTabId === tabId) lastActiveTabId = null;
});

installTabGroupBadge();

// Without this, side_panel.default_path in manifest.json only makes the
// panel reachable via Chrome's own side-panel picker — the extension's own
// toolbar icon does nothing on click, since there's no action.default_popup
// either. This makes clicking the icon open the panel directly, the
// behavior most people expect from a toolbar icon.
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("[browsercontrol] setPanelBehavior failed:", e));

// chrome.debugger is unavailable in offscreen documents, so offscreen holds
// the daemon WebSocket + recording canvas/MediaRecorder (lib/capture.ts)
// while this service worker does all CDP work, connected via
// chrome.runtime.sendMessage/Port.
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

async function ensureOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        // WORKERS is the closest fit for "hold a WebSocket" — unlike
        // AUDIO_PLAYBACK it has no auto-close timer.
        reasons: ["WORKERS" as chrome.offscreen.Reason],
        justification:
            "Holds a persistent WebSocket connection to the local BrowserControl daemon, and hosts the canvas/MediaRecorder pipeline for browser_start_recording/browser_stop_recording.",
    });
}

interface RelayMessage {
    target: "background";
    payload: BrowserCommand & { id: string };
}

chrome.runtime.onMessage.addListener(
    (message: RelayMessage, _sender, sendResponse) => {
        if (message?.target !== "background") return;
        dispatchCommand(message.payload)
            .then(sendResponse)
            .catch((e: unknown) => sendResponse({ error: errorMessage(e) }));
        return true; // keep the message channel open for the async response
    },
);

// The offscreen document opens a long-lived Port (not one-off sendMessage)
// to stream screencast frames for browser_start_recording — see
// lib/screencast.ts for why this rides CDP's Page.startScreencast instead
// of chrome.tabCapture.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "capture-frames") return;
    void handleCaptureConnection(port);
});

// Recording stays scoped to lastActiveTabId, not a specific tabId param —
// capture.ts/screencast.ts hold single-recording-at-a-time state (one
// canvas, one MediaRecorder), so multi-tab concurrent recording isn't a
// thing yet even though click/type/snapshot/etc. can now target any tab.
async function handleCaptureConnection(
    port: chrome.runtime.Port,
): Promise<void> {
    if (!lastActiveTabId) {
        port.postMessage({
            error: "No active tab",
            hint: "Call browser_navigate or browser_switch_tab first to establish which tab to record.",
        });
        port.disconnect();
        return;
    }
    try {
        await attachDebuggerIfNeeded(lastActiveTabId);
    } catch (e) {
        port.postMessage({ error: errorMessage(e) });
        port.disconnect();
        return;
    }
    const target = { tabId: lastActiveTabId };
    const result = await startScreencastRelay(target, port);
    port.postMessage(result);
    if ("error" in result) {
        port.disconnect();
        return;
    }
    port.onDisconnect.addListener(() => {
        void stopScreencastRelay(target);
    });
}

installDialogAutoHandler();
installNetworkCollector(() => lastActiveTabId);
installScreencastFrameRelay(() => lastActiveTabId);
ensureOffscreenDocument();
chrome.runtime.onStartup.addListener(ensureOffscreenDocument);

async function attachDebuggerIfNeeded(tabId: number) {
    if (attachedTabIds.has(tabId)) return;
    // attach's callback fires on failure too (e.g. DevTools already
    // debugging this tab) — must check lastError, or the failure is
    // swallowed and the tab gets marked "attached" anyway.
    await new Promise<void>((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
            const err = chrome.runtime.lastError;
            if (err) {
                reject(
                    new Error(
                        `Failed to attach debugger to tab ${tabId}: ${err.message}. If this says another debugger is already attached, close DevTools on that tab (or whatever else is debugging it) and retry.`,
                    ),
                );
            } else resolve();
        });
    });
    attachedTabIds.add(tabId);
    // Independent domains, enabled concurrently (~1 round-trip instead of
    // 6): Page (dialogs), DOM (getBoxModel), Network, CSS, Overlay,
    // Accessibility (queryAXTree). Accessibility.getFullAXTree/
    // getPartialAXTree (lib/snapshot.ts) tolerate the domain being
    // disabled and answer anyway, but Accessibility.queryAXTree (used by
    // lib/actions.ts's getAxInfoForNode, i.e. every click/type/press_key
    // that resolves a role+name) does not — without an explicit enable
    // first, chrome.debugger.sendCommand's callback for queryAXTree just
    // never fires (same silent-hang symptom as cdp.ts's header comment,
    // easy to misdiagnose as that same generic flakiness). Playwright/
    // Puppeteer both enable Accessibility before querying for the same
    // reason.
    const target = { tabId };
    await Promise.all([
        sendCommand(target, "Page.enable"),
        sendCommand(target, "DOM.enable"),
        sendCommand(target, "Network.enable"),
        sendCommand(target, "CSS.enable"),
        sendCommand(target, "Overlay.enable"),
        sendCommand(target, "Accessibility.enable"),
    ]);
}

async function dispatchCommand(
    data: BrowserCommand & { id?: string },
): Promise<Record<string, unknown>> {
    const cmd = data.cmd;

    if (cmd === "navigate") {
        return await handleNavigate(data.url, {
            tabId: data.tabId,
            newTab: data.newTab,
            background: data.background,
        });
    }

    // Neither needs a CDP session, and both must work before any navigate
    // has happened — a user might create the tab group and drop tabs in
    // first, then ask the AI to look.
    if (cmd === "list_tabs") {
        return await handleListTabsCommand(lastActiveTabId);
    }
    if (cmd === "switch_tab") {
        // Just repoints the DEFAULT target — does NOT detach whichever tab
        // was active before, so that tab stays usable via an explicit
        // tabId on later commands. This (not detach-then-reattach) is what
        // actually makes multi-tab work.
        const result = await handleSwitchTabCommand(data.tabId);
        if ("success" in result) lastActiveTabId = result.newActiveTabId;
        return result;
    }

    // batch_crawl needs DOMParser, which offscreen.ts's ws.onmessage handles
    // directly (same as start_capture/stop_capture) before it would ever
    // reach here — no branch for it in this function on purpose.

    // No CDP session needed — chrome.tabs.onRemoved (see above) cleans up
    // attachedTabIds/lastActiveTabId on its own once the tab is actually
    // gone, so there's nothing else to reconcile here.
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

    // Explicit tabId targets that tab regardless of what's "current";
    // omitted, it falls back to lastActiveTabId — today's single-tab
    // behavior, unchanged for any caller that never passes tabId.
    const targetTabId = data.tabId ?? lastActiveTabId;
    if (!targetTabId) {
        return { error: "No active session. Call navigate first." };
    }
    await attachDebuggerIfNeeded(targetTabId);
    const target = { tabId: targetTabId };

    if (cmd === "snapshot") return await handleSnapshotCommand(target);

    if (cmd === "query_region")
        return await handleQueryRegionCommand(target, data.selector);

    if (cmd === "visual_snapshot")
        return await handleVisualSnapshotCommand(target);

    if (cmd === "reading_mode")
        return await handleReadingModeCommand(target, data.maxChars);

    if (cmd === "find")
        return await handleFindCommand(target, data.query, data.limit);

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
        return await performClick(target, data.nodeId, { fast: false });
    }

    if (cmd === "type") {
        if (!data.text) return { error: "Missing text" };
        return await performType(target, data.nodeId, data.text, {
            fast: false,
        });
    }

    if (cmd === "press_key") {
        return await performPressKey(target, data.key, data.nodeId, {
            fast: false,
        });
    }

    if (cmd === "run_flow" || cmd === "explore_flow") {
        if (!Array.isArray(data.steps) || data.steps.length === 0) {
            return {
                error: "Missing steps",
                hint: "Pass a non-empty array of flow steps, e.g. [{action:'click', role:'button', name:'Login'}].",
            };
        }
        return await runFlowSteps(target, data.steps, {
            captureEachStep: cmd === "explore_flow",
        });
    }

    if (cmd === "scroll") {
        return await performScroll(target, data.deltaX || 0, data.deltaY || 0, {
            fast: false,
        });
    }

    if (cmd === "drag") {
        return await performDrag(
            target,
            data.fromX,
            data.fromY,
            data.toX,
            data.toY,
            { fast: false },
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
        return { success: true, message: "Network log cleared." };
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
        hint: `This loaded extension is v${EXTENSION_VERSION}. If "${cmd}" is a real browsercontrol command, the extension in chrome://extensions is running an older build than the daemon — reload it there (MV3 extensions never pick up source changes automatically). Do not work around this by installing other automation libraries; it's a stale-extension issue, not a missing capability.`,
    };
}

// Bounds the "wait for the tab to finish loading" step below — a page that
// never fires "complete" (a stuck download, an SSE stream) would otherwise
// leave the chrome.tabs.onUpdated listener registered forever.
const NAVIGATE_LOAD_TIMEOUT_MS = 20000;

async function handleNavigate(
    url: string,
    opts: { tabId?: number; newTab?: boolean; background?: boolean } = {},
): Promise<Record<string, unknown>> {
    clearNetworkRequests();

    let windowId: number | undefined;
    let tabId: number;
    let reuseExistingTab: boolean;
    // background:true (browser_start_job's worker tabs, see jobs.ts) must
    // not touch lastActiveTabId or steal window focus — a job runs
    // alongside the caller's own foreground session, not instead of it.
    const active = !opts.background;

    // Three ways in: explicit tabId re-navigates that specific tab; newTab
    // always opens a fresh one; otherwise reuse lastActiveTabId if still
    // alive, else create one (the original single-tab default).
    if (opts.tabId != null) {
        try {
            await chrome.tabs.get(opts.tabId);
        } catch {
            return {
                error: `No tab with id ${opts.tabId}`,
                hint: "Call browser_list_tabs to see currently open tabs, or omit tabId to open a new one.",
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
        // lastActiveTabId goes stale the moment its tab is closed, and the
        // service worker has no way to notice on its own until it tries to
        // use it — fall back to a fresh tab instead of hard-failing.
        let existingTabIsValid = false;
        if (lastActiveTabId) {
            try {
                await chrome.tabs.get(lastActiveTabId);
                existingTabIsValid = true;
            } catch {
                console.log(
                    `Stale lastActiveTabId ${lastActiveTabId} (tab no longer exists) — creating a new tab.`,
                );
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
    if (!opts.background) lastActiveTabId = tabId;

    // Chrome-active isn't OS-active — bring the window forward so the
    // animations are actually visible. Skipped for background tabs.
    if (windowId !== undefined && !opts.background) {
        chrome.windows.update(windowId, { focused: true }, () => {
            if (chrome.runtime.lastError)
                console.log(
                    "Could not focus window:",
                    chrome.runtime.lastError.message,
                );
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
        function listener(
            updatedTabId: number,
            info: chrome.tabs.TabChangeInfo,
        ) {
            if (updatedTabId === tabId && info.status === "complete") {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });

    await attachDebuggerIfNeeded(tabId);
    await waitForStableDom({ tabId }, { timeoutMs: 3000 });

    // Skipped for background tabs — nobody's watching one.
    if (!opts.background) {
        let hostname = url;
        try {
            hostname = new URL(url).hostname || url;
        } catch {
            // Not a parseable absolute URL — show it verbatim.
        }
        void evalOnPage(
            { tabId },
            `(${showPillCaption.toString()})(${JSON.stringify("🌐")}, ${JSON.stringify(`Navigated to ${hostname}`)}, ${JSON.stringify("#6ee7b7")}, ${JSON.stringify("#34d399")}, false)`,
        );
    }

    // tabId in the response is what a caller doing multi-tab work captures
    // and passes as `tabId` on later commands to keep targeting this exact
    // tab, instead of whichever one is lastActiveTabId by then.
    return { success: true, message: `Navigated to ${url}`, tabId };
}

});

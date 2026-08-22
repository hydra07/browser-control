import type { BrowserCommand, FlowStep } from "@browsercontrol/shared";
import { sendCommand } from "../libs/cdp.js";
import { errorMessage } from "../libs/errorMessage.js";
import { installDialogAutoHandler } from "../modules/dialog/index.js";
import type { DispatchCtx } from "../modules/dispatch/index.js";
import { dispatchCommand } from "../modules/dispatch/index.js";
import { forgetTab, installInterceptor, isSandboxed } from "../modules/interceptor/index.js";
import { installNetworkCollector } from "../modules/network/index.js";
import { flowRecorder } from "../modules/recorder/index.js";
import {
    installScreencastFrameRelay,
    isRecording,
    startScreencastRelay,
    stopScreencastRelay,
} from "../modules/screencast/index.js";
import { installTabGroupBadge } from "../modules/tabs/index.js";
import { telemetryCollector } from "../modules/telemetry/index.js";

/** Background service worker entrypoint managing CDP debugger attachments and command routing. */
export default defineBackground(() => {
    const EXTENSION_VERSION = chrome.runtime.getManifest().version;

    let lastActiveTabId: number | null = null;
    const attachedTabIds = new Set<number>();
    const lastActivityAt = new Map<number, number>();

    /** Clear attachment state if Chrome or DevTools detaches the session. */
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId != null) {
            attachedTabIds.delete(source.tabId);
            lastActivityAt.delete(source.tabId);
        }
    });

    /** Proactively detach debugger from idle tabs to dismiss the infobar banner. */
    const IDLE_DETACH_MINUTES = 3;

    chrome.alarms.create("idle-debugger-detach", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== "idle-debugger-detach") return;
        const cutoff = Date.now() - IDLE_DETACH_MINUTES * 60_000;
        for (const tabId of attachedTabIds) {
            // Avoid detaching during an active screen recording session
            if (isRecording() && tabId === lastActiveTabId) continue;
            if ((lastActivityAt.get(tabId) ?? 0) > cutoff) continue;
            chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
        }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
        attachedTabIds.delete(tabId);
        lastActivityAt.delete(tabId);
        forgetTab(tabId);
        if (lastActiveTabId === tabId) lastActiveTabId = null;
    });

    installTabGroupBadge();

    // Open side panel directly on clicking extension icon in toolbar
    chrome.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch((e) => console.error("[browsercontrol] setPanelBehavior failed:", e));

    const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

    async function ensureOffscreenDocument(): Promise<void> {
        if (await chrome.offscreen.hasDocument()) return;
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ["WORKERS" as chrome.offscreen.Reason],
            justification: "Holds persistent WebSocket bridge and offscreen canvas/MediaRecorder pipeline.",
        });
    }

    interface RelayMessage {
        target: "background";
        payload: BrowserCommand & { id: string };
    }

    async function attachDebuggerIfNeeded(tabId: number) {
        lastActivityAt.set(tabId, Date.now());
        if (attachedTabIds.has(tabId)) return;

        await new Promise<void>((resolve, reject) => {
            chrome.debugger.attach({ tabId }, "1.3", () => {
                const err = chrome.runtime.lastError;
                if (err) {
                    reject(
                        new Error(
                            `Failed to attach debugger to tab ${tabId}: ${err.message}. If another debugger is attached, close DevTools and retry.`,
                        ),
                    );
                } else resolve();
            });
        });
        attachedTabIds.add(tabId);

        // Enable required CDP domains concurrently
        const target = { tabId };
        await Promise.all([
            sendCommand(target, "Page.enable"),
            sendCommand(target, "DOM.enable"),
            sendCommand(target, "Network.enable"),
            sendCommand(target, "CSS.enable"),
            sendCommand(target, "Overlay.enable"),
            sendCommand(target, "Accessibility.enable"),
        ]);

        // Restore Fetch interception if tab was previously sandboxed
        if (isSandboxed(tabId)) {
            await sendCommand(target, "Fetch.enable", { patterns: [{ requestStage: "Request" }] }).catch(() => {});
        }
    }

    const dispatchCtx: DispatchCtx = {
        getLastActiveTabId: () => lastActiveTabId,
        setLastActiveTabId: (id) => {
            lastActiveTabId = id;
        },
        attachDebuggerIfNeeded,
        extensionVersion: EXTENSION_VERSION,
    };

    chrome.runtime.onMessage.addListener(
        (message: RelayMessage | { type: string; step: FlowStep }, _sender, sendResponse) => {
            if ("type" in message && message.type === "auto_flow_step") {
                flowRecorder.addStep(message.step);
                sendResponse({ received: true });
                return true;
            }
            if (!("target" in message) || message?.target !== "background") return;
            const start = Date.now();
            dispatchCommand(message.payload, dispatchCtx)
                .then((result) => {
                    const duration = Date.now() - start;
                    const telemetry = telemetryCollector.collectSnapshot(duration);
                    sendResponse({ result, telemetry });
                })
                .catch((e: unknown) => sendResponse({ error: errorMessage(e) }));
            return true; // keep the message channel open for the async response
        },
    );

    // Offscreen document streams screencast frames for recording over a Port
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== "capture-frames") return;
        void handleCaptureConnection(port);
    });

    async function handleCaptureConnection(port: chrome.runtime.Port): Promise<void> {
        if (!lastActiveTabId) {
            port.postMessage({
                error: "No active tab",
                hint: 'Call browser_session({action:"navigate"}) or browser_session({action:"switch_tab"}) first to establish which tab to record.',
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
    installInterceptor();
    installScreencastFrameRelay(() => lastActiveTabId);
    ensureOffscreenDocument();
    chrome.runtime.onStartup.addListener(ensureOffscreenDocument);
});

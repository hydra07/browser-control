import type { BrowserCommand, FlowStep } from "@browsercontrol/shared";
import { getSettings, type Settings, saveSettings } from "../configs/settings.js";
import { sendCommand, setDebuggerHooks } from "../libs/cdp.js";
import { errorMessage } from "../libs/errorMessage.js";
import { installDialogAutoHandler } from "../modules/dialog/index.js";
import type { DispatchCtx } from "../modules/dispatch/index.js";
import { dispatchCommand } from "../modules/dispatch/index.js";
import {
    installActionLifecycleEvidence,
    persistEvidenceTimeline,
    restoreEvidenceTimeline,
} from "../modules/evidence/index.js";
import { forgetTab, installInterceptor, isSandboxed } from "../modules/interceptor/index.js";
import { installNetworkCollector } from "../modules/network/index.js";
import { installActionLifecycleOverlay } from "../modules/overlay/index.js";
import { flowRecorder } from "../modules/recorder/index.js";
import {
    installScreencastFrameRelay,
    isRecording,
    startScreencastRelay,
    stopScreencastRelay,
} from "../modules/screencast/index.js";
import { clearSemanticState } from "../modules/snapshot/index.js";
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
        clearSemanticState(tabId);
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

    type RuntimeMessage =
        | RelayMessage
        | { type: "auto_flow_step"; step: FlowStep }
        | { type: "get_extension_version" }
        | { type: "get_settings" }
        | { type: "save_settings"; patch: Partial<Settings> };

    async function attachDebuggerIfNeeded(tabId: number): Promise<void> {
        lastActivityAt.set(tabId, Date.now());

        // Validate ground truth: is the debugger truly attached in Chrome?
        const targets = await chrome.debugger.getTargets().catch(() => []);
        const isAttached = targets.some((t) => t.tabId === tabId && t.attached);
        if (isAttached) {
            attachedTabIds.add(tabId);
            return;
        }

        // Stale in cache or detached by Chrome (e.g. cross-origin process swap) — re-attach
        attachedTabIds.delete(tabId);

        await new Promise<void>((resolve, reject) => {
            chrome.debugger.attach({ tabId }, "1.3", () => {
                const err = chrome.runtime.lastError;
                const msg = err?.message ?? "";
                if (err && !msg.includes("already attached")) {
                    reject(
                        new Error(
                            `Failed to attach debugger to tab ${tabId}: ${msg}. If another debugger is attached, close DevTools and retry.`,
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

    setDebuggerHooks({
        onDetached: (tabId) => {
            attachedTabIds.delete(tabId);
            lastActivityAt.delete(tabId);
        },
        reattach: attachDebuggerIfNeeded,
    });

    const evidenceReady = restoreEvidenceTimeline().catch((error: unknown) => {
        console.warn("[browsercontrol] evidence timeline startup restore failed:", error);
    });
    installActionLifecycleEvidence(undefined, () => persistEvidenceTimeline());

    const dispatchCtx: DispatchCtx = {
        getLastActiveTabId: () => lastActiveTabId,
        setLastActiveTabId: (id) => {
            lastActiveTabId = id;
        },
        attachDebuggerIfNeeded,
        extensionVersion: EXTENSION_VERSION,
    };

    chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
        if ("type" in message) {
            if (message.type === "get_extension_version") {
                sendResponse({ version: EXTENSION_VERSION });
                return true;
            }
            if (message.type === "get_settings") {
                void getSettings()
                    .then((settings) => sendResponse({ settings }))
                    .catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
                return true;
            }
            if (message.type === "save_settings") {
                void saveSettings(message.patch)
                    .then((settings) => sendResponse({ settings }))
                    .catch((error: unknown) => sendResponse({ error: errorMessage(error) }));
                return true;
            }
            if (message.type === "auto_flow_step") {
                flowRecorder.addStep(message.step);
                sendResponse({ received: true });
                return true;
            }
            return;
        }
        if (message.target !== "background") return;
        const start = Date.now();
        evidenceReady
            .then(() => dispatchCommand(message.payload, dispatchCtx))
            .then((result) => {
                const duration = Date.now() - start;
                const telemetry = telemetryCollector.collectSnapshot(duration);
                sendResponse({ result, telemetry });
            })
            .catch((e: unknown) => sendResponse({ error: errorMessage(e) }));
        return true; // keep the message channel open for the async response
    });

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

    installActionLifecycleOverlay((tabId) => ({ tabId }));
    installDialogAutoHandler();
    installNetworkCollector(() => lastActiveTabId);
    installInterceptor();
    installScreencastFrameRelay(() => lastActiveTabId);
    ensureOffscreenDocument();
    chrome.runtime.onStartup.addListener(ensureOffscreenDocument);
});

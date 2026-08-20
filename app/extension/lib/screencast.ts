// Feeds capture.ts (offscreen document) a live stream of frames for
// browser_start_recording/browser_stop_recording — via CDP's
// Page.startScreencast, not chrome.tabCapture, since tabCapture needs a real
// user gesture (activeTab) that an AI-driven recording has no way to
// provide. Screencast rides the same chrome.debugger session as click/type/
// screenshot instead, authorized once via the "debugger" permission.
import type { Protocol } from "devtools-protocol";
import { sendCommand, errorMessage } from "./cdp.js";
import { getSettings } from "./settings.js";

// The offscreen document's connection for the recording in progress, if
// any — only one recording runs at a time.
let capturePort: chrome.runtime.Port | null = null;

// Installed once at startup (background.ts), like installNetworkCollector.
let relayedFrameCount = 0;

export function installScreencastFrameRelay(
    getActiveTabId: () => number | null,
): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method !== "Page.screencastFrame") return;
        // Logged unconditionally (even with nothing recording) so the
        // service worker console can tell "CDP never sent a frame" apart
        // from "a frame got dropped somewhere in the relay".
        console.log(
            "[browsercontrol] screencastFrame event, tab",
            source.tabId,
            "capturing:",
            !!capturePort,
        );
        if (!capturePort) return;
        if (!source.tabId || source.tabId !== getActiveTabId()) return;
        const p = params as Protocol.Page.ScreencastFrameEvent;
        try {
            capturePort.postMessage({ data: p.data, metadata: p.metadata });
            relayedFrameCount++;
            console.log("[browsercontrol] relayed frame", relayedFrameCount);
        } catch (e) {
            // Port already disconnected (offscreen tore down mid-frame) —
            // drop the frame, nothing else to do.
            console.error(
                "[browsercontrol] capture port send failed:",
                errorMessage(e),
            );
        }
        // Chrome pauses the screencast until each frame is ack'd, which is
        // all the frame-rate throttling this needs.
        void sendCommand(
            { tabId: source.tabId },
            "Page.screencastFrameAck",
            { sessionId: p.sessionId },
        ).catch(() => {});
    });
}

export async function startScreencastRelay(
    target: chrome.debugger.Debuggee,
    port: chrome.runtime.Port,
): Promise<{ success: true } | { error: string; hint: string }> {
    if (capturePort) {
        return {
            error: "Already recording",
            hint: "Only one recording can run at a time — call browser_session({action:\"stop_recording\"}) first.",
        };
    }
    relayedFrameCount = 0;
    try {
        // Defaults (see lib/settings.ts) are capped well below native/4K
        // resolution so each frame stays a small-enough JPEG for the
        // offscreen canvas pipeline to decode, draw, and re-encode in real
        // time — decode+encode latency directly caps frame rate (frames are
        // ack'd one at a time), so raising quality/resolution trades away
        // smoothness, it isn't free.
        const { recordingQuality, recordingMaxWidth, recordingMaxHeight } = await getSettings();
        await sendCommand(target, "Page.startScreencast", {
            format: "jpeg",
            quality: recordingQuality,
            maxWidth: recordingMaxWidth,
            maxHeight: recordingMaxHeight,
            everyNthFrame: 1,
        });
    } catch (e) {
        return {
            error: "Failed to start screencast",
            hint: errorMessage(e),
        };
    }
    capturePort = port;
    return { success: true };
}

/** Whether a recording is currently in progress — background.ts's idle-detach check must never detach the tab a recording is riding on. */
export function isRecording(): boolean {
    return capturePort !== null;
}

export async function stopScreencastRelay(
    target: chrome.debugger.Debuggee,
): Promise<void> {
    capturePort = null;
    try {
        await sendCommand(target, "Page.stopScreencast");
    } catch {
        // Tab may already be gone (closed mid-recording) — nothing to clean
        // up on the CDP side in that case.
    }
}

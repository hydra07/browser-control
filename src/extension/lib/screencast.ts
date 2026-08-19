// Feeds capture.ts (offscreen document) a live stream of frames for
// browser_start_recording/browser_stop_recording — via CDP's
// Page.startScreencast, NOT chrome.tabCapture. tabCapture.getMediaStreamId
// requires activeTab permission granted by a real user gesture (clicking the
// extension's toolbar icon) or throws "Extension has not been invoked for
// the current page"; an AI-driven recording triggered from the daemon has no
// such gesture to point to. Page.startScreencast has no such restriction —
// it rides the same chrome.debugger session already used for click/type/
// screenshot, authorized once via the "debugger" + host_permissions grant,
// not per-recording.
import type { Protocol } from "devtools-protocol";
import { sendCommand, errorMessage } from "./cdp.js";

// The offscreen document's live connection for the recording in progress, if
// any. Frames are pushed to it as { data, metadata }; only one recording can
// be active at a time (dispatchCommand's start_capture path never races this
// since it's all single-threaded within the service worker).
let capturePort: chrome.runtime.Port | null = null;

// Call once at startup (background.ts), same pattern as
// installNetworkCollector/installDialogAutoHandler — a single long-lived
// chrome.debugger.onEvent listener rather than one added/removed per
// recording, so there's nothing to leak if start/stop ever gets out of sync.
let relayedFrameCount = 0;

export function installScreencastFrameRelay(
    getActiveTabId: () => number | null,
): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method !== "Page.screencastFrame") return;
        // Logged even when nothing is recording (capturePort null) or the
        // tab doesn't match — if start_capture reports success but the
        // recording still comes out empty, this line (or its absence) in
        // chrome://extensions -> BrowserControl Agent -> "service worker"
        // console says whether CDP ever sent a frame at all, vs. it being
        // dropped/lost somewhere in the relay-to-canvas pipeline.
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
            // nothing useful to do with this frame, just drop it.
            console.error(
                "[browsercontrol] capture port send failed:",
                errorMessage(e),
            );
        }
        // Chrome pauses the screencast until each frame is ack'd — this is
        // the natural backpressure that keeps frame rate matched to how fast
        // the offscreen doc can actually draw+encode, so no separate
        // throttling logic is needed here.
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
            hint: "Only one recording can run at a time — call browser_stop_recording first.",
        };
    }
    relayedFrameCount = 0;
    try {
        // Capped, not native resolution — on a 4K/HiDPI display an
        // uncapped screencast means every frame is a multi-megapixel JPEG to
        // decode, draw, and re-encode through MediaRecorder, which the
        // offscreen document's canvas pipeline can't keep up with in real
        // time. 1280x900 comfortably covers a typical viewport for reviewing
        // UI behavior without needing pixel-exact detail.
        //
        // The whole point of recording (vs. a screenshot) is to show the
        // agent's own cursor-glide/ripple/highlight animations in motion —
        // background.ts injects those as real DOM elements, so the
        // screencast sees them like anything else on the page, but only as
        // fast as this pipeline can keep up: Chrome pauses new frames until
        // the previous one is ack'd (see installScreencastFrameRelay), so
        // decode+draw+encode latency directly caps the effective frame rate.
        // Quality 50 trades per-frame sharpness for a smaller JPEG to
        // decode — more frames landing during a ~1s cursor glide reads as
        // motion; a handful of crisp ones reads as a slideshow.
        await sendCommand(target, "Page.startScreencast", {
            format: "jpeg",
            quality: 50,
            maxWidth: 1280,
            maxHeight: 900,
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

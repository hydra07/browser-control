/**
 * Screencast frame relay via CDP Page.startScreencast, streaming JPEG frames to offscreen document.
 */
import type { Protocol } from "devtools-protocol";
import { getSettings } from "../../configs/settings.js";
import { sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";

export class ScreencastRelay {
    private capturePort: chrome.runtime.Port | null;
    private relayedFrameCount: number;
    private tabId: number | undefined;
    private listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | null;

    constructor() {
        this.capturePort = null;
        this.relayedFrameCount = 0;
        this.listener = null;
    }

    public install(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
        }
        this.listener = (source, method, params) => {
            if (method !== "Page.screencastFrame") return;
            if (!this.capturePort) return;
            if (!source.tabId || source.tabId !== this.tabId) return;
            const p = params as Protocol.Page.ScreencastFrameEvent;
            try {
                this.capturePort.postMessage({ data: p.data, metadata: p.metadata });
                this.relayedFrameCount++;
            } catch (e) {
                console.error("[browsercontrol] capture port send failed:", errorMessage(e));
            }
            void sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(
                () => {},
            );
        };
        chrome.debugger.onEvent.addListener(this.listener);
    }

    public async start(
        target: chrome.debugger.Debuggee,
        port: chrome.runtime.Port,
    ): Promise<{ success: true } | { error: string; hint: string }> {
        if (this.capturePort) {
            return {
                error: "Already recording",
                hint: "Only one recording can run at a time — call `browsercontrol capture stop` first.",
            };
        }
        this.relayedFrameCount = 0;
        this.tabId = target.tabId;
        this.capturePort = port;
        try {
            const { recordingQuality, recordingMaxWidth, recordingMaxHeight } = await getSettings();
            await sendCommand(target, "Page.startScreencast", {
                format: "jpeg",
                quality: recordingQuality,
                maxWidth: recordingMaxWidth,
                maxHeight: recordingMaxHeight,
                everyNthFrame: 1,
            });
        } catch (e) {
            this.capturePort = null;
            this.tabId = undefined;
            return {
                error: "Failed to start screencast",
                hint: errorMessage(e),
            };
        }
        this.capturePort = port;
        return { success: true };
    }

    public isRecording(): boolean {
        return this.capturePort !== null;
    }

    public getRelayedFrameCount(): number {
        return this.relayedFrameCount;
    }

    public async stop(target: chrome.debugger.Debuggee): Promise<void> {
        this.capturePort = null;
        this.tabId = undefined;
        try {
            await sendCommand(target, "Page.stopScreencast");
        } catch {
            // Target may already be closed
        }
    }

    public dispose(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
            this.listener = null;
        }
        this.capturePort?.disconnect();
        this.capturePort = null;
        this.relayedFrameCount = 0;
    }
}

export const screencastRelay = new ScreencastRelay();

export function installScreencastFrameRelay(): void {
    screencastRelay.install();
}

export function startScreencastRelay(
    target: chrome.debugger.Debuggee,
    port: chrome.runtime.Port,
): Promise<{ success: true } | { error: string; hint: string }> {
    return screencastRelay.start(target, port);
}

export function isRecording(): boolean {
    return screencastRelay.isRecording();
}

export function stopScreencastRelay(target: chrome.debugger.Debuggee): Promise<void> {
    return screencastRelay.stop(target);
}

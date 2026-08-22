/**
 * Holds the WebSocket bridge to the daemon, relaying messages to the service worker.
 * Runs DOM-dependent operations (MediaRecorder, DOMParser) directly here.
 */
import { BinaryOpcode, type BrowserCommand, encodeBinaryPacket } from "@browsercontrol/shared";
import { errorMessage } from "../../libs/errorMessage.js";
import { startCapture, stopCapture } from "../../modules/capture/index.js";
import { handleWebSearchCommand } from "../../modules/search/index.js";

type IncomingMessage = BrowserCommand & { id: string };

const WS_URL = "ws://127.0.0.1:8765";
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

/**
 * Manages the persistent WebSocket lifecycle, message routing,
 * exponential-backoff reconnection, and graceful teardown for the offscreen document.
 */
export class OffscreenDaemonBridge {
    private ws: WebSocket | null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null;
    private reconnectDelayMs: number;
    private isDisposed: boolean;
    private readonly wsUrl: string;

    constructor(wsUrl = WS_URL) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.reconnectTimer = null;
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        this.isDisposed = false;
    }

    public isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    public connect(): void {
        if (this.isDisposed) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.clearReconnectTimer();

        try {
            const socket = new WebSocket(this.wsUrl);
            socket.binaryType = "arraybuffer";

            socket.onopen = () => {
                console.log("[offscreen] Connected to daemon");
                this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
            };

            socket.onmessage = (event: MessageEvent) => {
                void this.handleIncomingMessage(event);
            };

            socket.onclose = () => {
                if (this.isDisposed) return;
                this.ws = null;
                console.log(`[offscreen] Disconnected from daemon, retrying in ${this.reconnectDelayMs}ms`);
                this.scheduleReconnect();
            };

            socket.onerror = () => {
                socket.close();
            };

            this.ws = socket;
        } catch (err) {
            console.error("[offscreen] Failed to create WebSocket connection:", errorMessage(err));
            this.scheduleReconnect();
        }
    }

    public sendJson(payload: unknown): boolean {
        if (!this.isConnected() || !this.ws) return false;
        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch (err) {
            console.error("[offscreen] Error sending JSON payload:", errorMessage(err));
            return false;
        }
    }

    public sendBinary(packet: Uint8Array): boolean {
        if (!this.isConnected() || !this.ws) return false;
        try {
            this.ws.send(packet);
            return true;
        } catch (err) {
            console.error("[offscreen] Error sending binary packet:", errorMessage(err));
            return false;
        }
    }

    private async handleIncomingMessage(event: MessageEvent): Promise<void> {
        let data: IncomingMessage;
        try {
            data = JSON.parse(event.data as string) as IncomingMessage;
        } catch (e: unknown) {
            console.error("[offscreen] Received malformed message:", errorMessage(e));
            return;
        }

        // 1. Capture commands require DOM context (MediaRecorder/Canvas) in offscreen document
        if (data.cmd === "start_capture" || data.cmd === "stop_capture") {
            try {
                const result =
                    data.cmd === "start_capture"
                        ? await startCapture((chunkBytes) => {
                              const packet = encodeBinaryPacket(BinaryOpcode.VIDEO_CHUNK, chunkBytes);
                              this.sendBinary(packet);
                          })
                        : await stopCapture();
                this.sendJson({ id: data.id, type: "result", data: result });
            } catch (e: unknown) {
                console.error("[offscreen] Capture command failed:", errorMessage(e));
                this.sendJson({ id: data.id, type: "error", error: errorMessage(e) });
            }
            return;
        }

        // 2. Web search uses offscreen document DOMParser
        if (data.cmd === "web_search") {
            try {
                const result = await handleWebSearchCommand(data);
                this.sendJson({ id: data.id, type: "result", data: result });
            } catch (e: unknown) {
                console.error(`[offscreen] ${data.cmd} failed:`, errorMessage(e));
                this.sendJson({ id: data.id, type: "error", error: errorMessage(e) });
            }
            return;
        }

        // 3. Relay all standard commands to background service worker
        try {
            const resp = await chrome.runtime.sendMessage({ target: "background", payload: data });
            if (resp && typeof resp === "object" && "result" in resp) {
                this.sendJson({ id: data.id, type: "result", data: resp.result, telemetry: resp.telemetry });
            } else if (resp?.error) {
                this.sendJson({ id: data.id, type: "error", error: resp.error });
            } else {
                this.sendJson({ id: data.id, type: "result", data: resp });
            }
        } catch (e: unknown) {
            console.error("[offscreen] Error relaying to background:", errorMessage(e));
            this.sendJson({ id: data.id, type: "error", error: errorMessage(e) });
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        if (this.isDisposed) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);

        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    public disconnect(): void {
        this.clearReconnectTimer();
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
    }

    public dispose(): void {
        this.isDisposed = true;
        this.disconnect();
    }
}

export const offscreenBridge = new OffscreenDaemonBridge();
offscreenBridge.connect();

window.addEventListener("beforeunload", () => {
    offscreenBridge.dispose();
});

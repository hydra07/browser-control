/**
 * Holds the WebSocket connection to the Go CLI bridge, relaying messages to the service worker.
 * Runs DOM-dependent operations (MediaRecorder, DOMParser) directly here.
 */
import { BinaryOpcode, type BrowserCommand, encodeBinaryPacket } from "@browsercontrol/shared";
import { getSettings, saveSettings } from "../../configs/settings.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { startCapture, stopCapture } from "../../modules/capture/index.js";
import { handleWebSearchCommand } from "../../modules/search/index.js";

type IncomingMessage = BrowserCommand & { id: string; deadline?: number };

const WS_URL = "ws://127.0.0.1:8765";
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;
const WS_PROTOCOL_VERSION = 2;
type ConnectionState = "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "READY";

interface HelloAck {
    type: "hello_ack";
    protocolVersion: number;
    serverVersion?: string;
    /** Sent only when the bridge auto-paired this extension (no or stale token); persisted for next time. */
    token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getExtensionVersion(): Promise<string> {
    if (typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function") {
        return chrome.runtime.getManifest().version;
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return "unknown";

    try {
        const response = (await chrome.runtime.sendMessage({
            target: "background",
            type: "get_extension_version",
        })) as { version?: unknown } | undefined;
        return typeof response?.version === "string" ? response.version : "unknown";
    } catch {
        return "unknown";
    }
}

/**
 * Manages the persistent WebSocket lifecycle, message routing,
 * exponential-backoff reconnection, and graceful teardown for the offscreen document.
 */
export class OffscreenBridge {
    private ws: WebSocket | null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null;
    private reconnectDelayMs: number;
    private isDisposed: boolean;
    private connectionState: ConnectionState;
    private readonly wsUrl: string;

    constructor(wsUrl = WS_URL) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.reconnectTimer = null;
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        this.isDisposed = false;
        this.connectionState = "DISCONNECTED";
    }

    public isConnected(): boolean {
        return this.connectionState === "READY" && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    public connect(): void {
        if (this.isDisposed) return;
        if (
            this.ws &&
            (this.connectionState === "CONNECTING" || this.connectionState === "AUTHENTICATING" || this.isConnected())
        ) {
            return;
        }

        this.clearReconnectTimer();
        this.connectionState = "CONNECTING";

        try {
            const socket = new WebSocket(this.wsUrl);
            socket.binaryType = "arraybuffer";

            socket.onopen = () => {
                this.connectionState = "AUTHENTICATING";
                void getSettings()
                    .then(async (settings) => {
                        if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
                        // An empty or stale token is still sent: the bridge auto-pairs its trusted extension origin
                        // and hands the real token back in hello_ack.
                        const token = settings.daemonAuthToken.trim();
                        socket.send(
                            JSON.stringify({
                                type: "hello",
                                protocolVersion: WS_PROTOCOL_VERSION,
                                role: "extension",
                                token,
                                clientVersion: await getExtensionVersion(),
                            }),
                        );
                    })
                    .catch((err: unknown) => {
                        console.error("[offscreen] Failed to load bridge pairing settings:", errorMessage(err));
                        socket.close(4003, "Bridge token unavailable");
                    });
            };

            socket.onmessage = (event: MessageEvent) => {
                if (socket === this.ws) void this.handleIncomingMessage(event, socket);
            };

            socket.onclose = () => {
                if (this.isDisposed || socket !== this.ws) return;
                this.connectionState = "DISCONNECTED";
                this.ws = null;
                void chrome.runtime.sendMessage({ type: "cancel_command" }).catch(() => {});
                void stopCapture().catch(() => {});
                console.log(`[offscreen] Disconnected from bridge, retrying in ${this.reconnectDelayMs}ms`);
                this.scheduleReconnect();
            };

            socket.onerror = () => {
                socket.close();
            };

            this.ws = socket;
        } catch (err) {
            this.connectionState = "DISCONNECTED";
            console.error("[offscreen] Failed to create WebSocket connection:", errorMessage(err));
            this.scheduleReconnect();
        }
    }

    public sendJson(payload: unknown, socket = this.ws): boolean {
        if (!this.isConnected() || !this.ws || socket !== this.ws) return false;
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
        if (this.ws.bufferedAmount + packet.byteLength > 8 * 1024 * 1024) {
            this.ws.close(4004, "Capture transport backpressure exceeded");
            return false;
        }
        try {
            const bytes = packet.slice();
            this.ws.send(bytes.buffer as ArrayBuffer);
            return true;
        } catch (err) {
            console.error("[offscreen] Error sending binary packet:", errorMessage(err));
            return false;
        }
    }

    private async handleIncomingMessage(event: MessageEvent, socket: WebSocket): Promise<void> {
        if (typeof event.data !== "string") return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(event.data);
        } catch (e: unknown) {
            console.error("[offscreen] Received malformed message:", errorMessage(e));
            return;
        }
        if (!isRecord(parsed)) return;
        if (parsed.type === "cancel" && typeof parsed.id === "string") {
            await chrome.runtime.sendMessage({ type: "cancel_command", id: parsed.id }).catch(() => {});
            return;
        }

        if (this.connectionState === "AUTHENTICATING") {
            const ack = parsed as Partial<HelloAck>;
            if (ack.type !== "hello_ack" || ack.protocolVersion !== WS_PROTOCOL_VERSION) {
                console.error("[offscreen] Bridge rejected the WebSocket protocol handshake");
                this.ws?.close(4002, "Protocol handshake failed");
                return;
            }
            this.connectionState = "READY";
            this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
            if (typeof ack.token === "string" && ack.token) {
                void saveSettings({ daemonAuthToken: ack.token })
                    .then(() => console.log("[offscreen] Auto-paired with bridge; token saved"))
                    .catch((err: unknown) =>
                        console.error("[offscreen] Failed to save paired token:", errorMessage(err)),
                    );
            }
            console.log(`[offscreen] Authenticated with bridge${ack.serverVersion ? ` v${ack.serverVersion}` : ""}`);
            return;
        }
        if (this.connectionState !== "READY") return;
        if (
            typeof parsed.id !== "string" ||
            typeof parsed.cmd !== "string" ||
            (parsed.deadline !== undefined &&
                (typeof parsed.deadline !== "number" || !Number.isFinite(parsed.deadline)))
        )
            return;

        const data = parsed as IncomingMessage;
        if (
            (data.deadline !== undefined && data.deadline <= Date.now()) ||
            (data.tabId !== undefined && (!Number.isInteger(data.tabId) || data.tabId <= 0))
        ) {
            this.sendJson(
                { id: data.id, type: "error", error: "Request expired or tabId invalid; no action was dispatched" },
                socket,
            );
            return;
        }

        // 1. Capture commands require DOM context (MediaRecorder/Canvas) in offscreen document
        if (data.cmd === "start_capture" || data.cmd === "stop_capture") {
            try {
                const result =
                    data.cmd === "start_capture"
                        ? await startCapture((chunkBytes) => {
                              const packet = encodeBinaryPacket(BinaryOpcode.VIDEO_CHUNK, chunkBytes);
                              if (socket !== this.ws || !this.sendBinary(packet))
                                  throw new Error("Capture chunk could not be sent");
                          }, data.tabId)
                        : await stopCapture();
                this.sendJson({ id: data.id, type: "result", data: result }, socket);
            } catch (e: unknown) {
                console.error("[offscreen] Capture command failed:", errorMessage(e));
                this.sendJson({ id: data.id, type: "error", error: errorMessage(e) }, socket);
            }
            return;
        }

        // 2. Web search uses offscreen document DOMParser
        if (data.cmd === "web_search") {
            try {
                const result = await handleWebSearchCommand(data);
                this.sendJson({ id: data.id, type: "result", data: result }, socket);
            } catch (e: unknown) {
                console.error(`[offscreen] ${data.cmd} failed:`, errorMessage(e));
                this.sendJson({ id: data.id, type: "error", error: errorMessage(e) }, socket);
            }
            return;
        }

        // 3. Relay all standard commands to background service worker
        try {
            const resp = await chrome.runtime.sendMessage({ target: "background", payload: data });
            if (resp && typeof resp === "object" && "result" in resp) {
                this.sendJson({ id: data.id, type: "result", data: resp.result, telemetry: resp.telemetry }, socket);
            } else if (resp?.error) {
                this.sendJson({ id: data.id, type: "error", error: resp.error }, socket);
            } else {
                this.sendJson({ id: data.id, type: "result", data: resp }, socket);
            }
        } catch (e: unknown) {
            console.error("[offscreen] Error relaying to background:", errorMessage(e));
            this.sendJson({ id: data.id, type: "error", error: errorMessage(e) }, socket);
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
        this.connectionState = "DISCONNECTED";
    }

    public dispose(): void {
        this.isDisposed = true;
        this.disconnect();
    }
}

export const offscreenBridge = new OffscreenBridge();
offscreenBridge.connect();

window.addEventListener("beforeunload", () => {
    offscreenBridge.dispose();
});

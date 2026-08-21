/**
 * Holds the WebSocket bridge to the daemon, relaying messages to the service worker.
 * Runs DOM-dependent operations (MediaRecorder, DOMParser) directly here.
 */
import type { BrowserCommand } from "@browsercontrol/shared";
import { errorMessage } from "../../libs/errorMessage.js";
import { handleBatchCrawlCommand } from "../../modules/batch/index.js";
import { startCapture, stopCapture } from "../../modules/capture/index.js";
import { handleWebSearchCommand } from "../../modules/search/index.js";

type IncomingMessage = BrowserCommand & { id: string };

const WS_URL = "ws://127.0.0.1:8765";
const MAX_RECONNECT_DELAY_MS = 15000;

let ws: WebSocket | null = null;
let reconnectDelayMs = 1000;

function ensureConnected(): void {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    connect();
}

function connect(): void {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log("[offscreen] Connected to daemon");
        reconnectDelayMs = 1000;
    };

    ws.onmessage = async (event: MessageEvent) => {
        let data: IncomingMessage;
        try {
            data = JSON.parse(event.data) as IncomingMessage;
        } catch (e: unknown) {
            console.error("[offscreen] Received malformed message:", errorMessage(e));
            return;
        }

        // Capture commands require DOM context (MediaRecorder/Canvas) in offscreen document
        if (data.cmd === "start_capture" || data.cmd === "stop_capture") {
            try {
                const result = data.cmd === "start_capture" ? await startCapture() : await stopCapture();
                ws?.send(JSON.stringify({ id: data.id, type: "result", data: result }));
            } catch (e: unknown) {
                console.error("[offscreen] Capture command failed:", errorMessage(e));
                ws?.send(JSON.stringify({ id: data.id, type: "error", error: errorMessage(e) }));
            }
            return;
        }

        // Batch crawl and search require DOMParser in offscreen document
        if (data.cmd === "batch_crawl" || data.cmd === "web_search") {
            try {
                const result =
                    data.cmd === "batch_crawl"
                        ? await handleBatchCrawlCommand(data)
                        : await handleWebSearchCommand(data);
                ws?.send(JSON.stringify({ id: data.id, type: "result", data: result }));
            } catch (e: unknown) {
                console.error(`[offscreen] ${data.cmd} failed:`, errorMessage(e));
                ws?.send(JSON.stringify({ id: data.id, type: "error", error: errorMessage(e) }));
            }
            return;
        }

        try {
            const resp = await chrome.runtime.sendMessage({ target: "background", payload: data });
            if (resp && typeof resp === "object" && "result" in resp) {
                ws?.send(JSON.stringify({ id: data.id, type: "result", data: resp.result, telemetry: resp.telemetry }));
            } else if (resp?.error) {
                ws?.send(JSON.stringify({ id: data.id, type: "error", error: resp.error }));
            } else {
                ws?.send(JSON.stringify({ id: data.id, type: "result", data: resp }));
            }
        } catch (e: unknown) {
            console.error("[offscreen] Error relaying to background:", errorMessage(e));
            ws?.send(JSON.stringify({ id: data.id, type: "error", error: errorMessage(e) }));
        }
    };

    ws.onclose = () => {
        console.log(`[offscreen] Disconnected from daemon, retrying in ${reconnectDelayMs}ms`);
        setTimeout(ensureConnected, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    };

    ws.onerror = () => ws?.close();
}

ensureConnected();

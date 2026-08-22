/**
 * Screen recording of the active tab running in the offscreen document.
 * Draws screencast frames onto an offscreen canvas and encodes via MediaRecorder.
 * Designed specifically for human visual verification, debugging, and feedback.
 */
import { errorMessage } from "../../libs/errorMessage.js";
import type { CaptureAck, CaptureError, CaptureResult, FrameMessage, PortAck } from "./types.js";

export type { CaptureAck, CaptureError, CaptureResult } from "./types.js";

const FIRST_FRAME_TIMEOUT_MS = 3000;

function pickSupportedMimeType(): string | undefined {
    for (const type of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return undefined;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
}

/**
 * Fast native base64 conversion using browser C++ FileReader instead of chunked JS string loops.
 * Allocates zero temporary multi-MB JavaScript arrays.
 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const res = reader.result as string;
            const commaIndex = res.indexOf(",");
            resolve(commaIndex >= 0 ? res.slice(commaIndex + 1) : res);
        };
        reader.onerror = () => reject(new Error("FileReader failed to convert video blob to base64"));
        reader.readAsDataURL(blob);
    });
}

export class ScreenCaptureManager {
    private port: chrome.runtime.Port | null;
    private canvas: HTMLCanvasElement | null;
    private ctx: CanvasRenderingContext2D | null;
    private track: CanvasCaptureMediaStreamTrack | null;
    private recorder: MediaRecorder | null;
    private chunks: Blob[];
    private onChunk: ((bytes: Uint8Array) => boolean) | null;
    private recordingStartedAt: number;
    private frameCount: number;
    private frameQueue: Promise<void>;
    private chunkQueue: Promise<void>;
    private pendingDrawCount: number;
    private firstFrameReady: Promise<void>;
    private resolveFirstFrame: (() => void) | null;
    private streamError: string | null;

    constructor() {
        this.port = null;
        this.canvas = null;
        this.ctx = null;
        this.track = null;
        this.recorder = null;
        this.chunks = [];
        this.onChunk = null;
        this.recordingStartedAt = 0;
        this.frameCount = 0;
        this.frameQueue = Promise.resolve();
        this.chunkQueue = Promise.resolve();
        this.pendingDrawCount = 0;
        this.firstFrameReady = Promise.resolve();
        this.resolveFirstFrame = null;
        this.streamError = null;
    }

    private async drawFrame(frame: FrameMessage): Promise<void> {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx) return;
        // Drop intermediate frame under heavy load to prevent memory accumulation
        if (this.pendingDrawCount > 3) return;

        this.pendingDrawCount++;
        try {
            const bitmap = await createImageBitmap(base64ToBlob(frame.data, "image/jpeg"));
            try {
                /** Decoding yields; teardown may have disposed this capture while the JPEG was in flight. */
                if (this.canvas !== canvas || this.ctx !== ctx) return;
                if (this.frameCount === 0) {
                    /** Matching the encoded track to the first real frame avoids stretching a 16:9 page into a 1280x900 canvas. */
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                }
                const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
                const width = Math.round(bitmap.width * scale);
                const height = Math.round(bitmap.height * scale);
                const x = Math.round((canvas.width - width) / 2);
                const y = Math.round((canvas.height - height) / 2);
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(bitmap, x, y, width, height);
                const activeTrack = this.track;
                if (activeTrack !== null) activeTrack.requestFrame();
                this.frameCount++;
                this.resolveFirstFrame?.();
                this.resolveFirstFrame = null;
            } finally {
                bitmap.close();
            }
        } finally {
            this.pendingDrawCount--;
        }
    }

    public isRecording(): boolean {
        return this.recorder !== null;
    }

    private queueChunk(blob: Blob, onChunk: (bytes: Uint8Array) => boolean): void {
        this.chunkQueue = this.chunkQueue
            .then(async () => {
                const buffer = await blob.arrayBuffer();
                if (!onChunk(new Uint8Array(buffer))) {
                    throw new Error("Daemon WebSocket disconnected while streaming video");
                }
            })
            .catch((e: unknown) => {
                this.streamError ??= errorMessage(e);
                console.error("[browsercontrol] Failed to stream video chunk:", this.streamError);
            });
    }

    private async stopRecorder(recorder: MediaRecorder): Promise<void> {
        if (recorder.state === "inactive") return;
        await new Promise<void>((resolve) => {
            recorder.addEventListener("stop", () => resolve(), { once: true });
            recorder.stop();
        });
    }

    public async start(tabId?: number, onChunk?: (bytes: Uint8Array) => boolean): Promise<CaptureAck | CaptureError> {
        if (this.recorder) {
            return {
                error: "Already recording",
                hint: 'Call browser_session({action:"stop_recording"}) first, or ignore if you meant to keep recording — this call was a no-op.',
            };
        }

        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 900;
        canvas.style.cssText = "position:fixed;left:-99999px;top:0;";
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            canvas.remove();
            return {
                error: "Failed to create capture canvas",
                hint: "2D canvas context unavailable in the offscreen document.",
            };
        }

        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        this.canvas = canvas;
        this.ctx = ctx;
        this.track = null;
        this.chunks = [];
        this.onChunk = onChunk ?? null;
        this.frameCount = 0;
        this.pendingDrawCount = 0;
        this.frameQueue = Promise.resolve();
        this.chunkQueue = Promise.resolve();
        this.firstFrameReady = new Promise((resolve) => {
            this.resolveFirstFrame = resolve;
        });
        this.streamError = null;

        const ack = await new Promise<PortAck>((resolve) => {
            const p = chrome.runtime.connect({ name: `capture-frames:${tabId ?? ""}` });
            this.port = p;
            let settled = false;
            p.onMessage.addListener((msg: FrameMessage | PortAck) => {
                if ("data" in msg) {
                    this.frameQueue = this.frameQueue
                        .then(() => this.drawFrame(msg))
                        .catch((e) => {
                            console.error("[browsercontrol] drawFrame failed:", errorMessage(e));
                        });
                    return;
                }
                if (!settled) {
                    settled = true;
                    resolve(msg);
                }
            });
            p.onDisconnect.addListener(() => {
                if (!settled) {
                    settled = true;
                    resolve({
                        error: "Capture connection closed",
                        hint: "The background service worker may have been terminated before confirming the recording started; try again.",
                    });
                }
            });
        });

        if ("error" in ack) {
            this.dispose();
            return ack;
        }

        await Promise.race([
            this.firstFrameReady,
            new Promise<void>((resolve) => setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS)),
        ]);
        await this.frameQueue;
        if (this.frameCount === 0 || !this.canvas) {
            this.dispose();
            return {
                error: "No screencast frames received",
                hint: "The selected tab did not produce an initial CDP frame. Focus a normal web tab, wait for it to finish loading, then retry.",
            };
        }

        const stream = this.canvas.captureStream(0);
        const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
        if (!track) {
            this.dispose();
            return {
                error: "Failed to create capture track",
                hint: "Canvas captureStream returned no video track.",
            };
        }
        this.track = track;

        const mimeType = pickSupportedMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const streamChunk = onChunk ?? null;
        recorder.ondataavailable = (e) => {
            if (e.data.size <= 0) return;
            if (streamChunk) this.queueChunk(e.data, streamChunk);
            else this.chunks.push(e.data);
        };
        recorder.onerror = (event) => {
            this.streamError ??= event.error.message;
        };
        this.recorder = recorder;

        try {
            this.recorder.start(500); // 500ms chunks for smooth real-time streaming
        } catch (e) {
            this.dispose();
            return {
                error: "Failed to start recording",
                hint: errorMessage(e),
            };
        }
        track.requestFrame();
        this.recordingStartedAt = Date.now();
        return {
            success: true,
            message: `Recording started on tab ${ack.tabId}.`,
            tabId: ack.tabId,
            width: this.canvas.width,
            height: this.canvas.height,
            mimeType: recorder.mimeType || mimeType || "video/webm",
        };
    }

    public async stop(): Promise<CaptureResult | CaptureError> {
        if (!this.recorder || !this.port) {
            return {
                error: "Not recording",
                hint: 'Call browser_session({action:"start_recording"}) first.',
            };
        }
        const finishedRecorder = this.recorder;
        const finishedPort = this.port;
        const finishedTrack = this.track;
        const wasStreamed = this.onChunk !== null;
        const durationMs = Date.now() - this.recordingStartedAt;
        const width = this.canvas?.width ?? 0;
        const height = this.canvas?.height ?? 0;
        const mimeType = finishedRecorder.mimeType || "video/webm";

        this.recorder = null;
        this.port = null;

        finishedPort.disconnect();
        await this.frameQueue;
        const frames = this.frameCount;

        if (wasStreamed) {
            await this.stopRecorder(finishedRecorder);
            await this.chunkQueue;
            finishedTrack?.stop();
            const streamError = this.streamError;
            this.dispose();
            if (streamError) {
                return {
                    error: "Recording stream failed",
                    hint: streamError,
                };
            }
            return {
                success: true,
                format: "webm",
                isStreamed: true,
                durationMs,
                frameCount: frames,
                width,
                height,
                mimeType,
            };
        }

        await this.stopRecorder(finishedRecorder);
        const blob = new Blob(this.chunks, { type: mimeType });
        finishedTrack?.stop();

        this.dispose();

        const dataBase64 = await blobToBase64(blob);
        return {
            success: true,
            format: "webm",
            dataBase64,
            durationMs,
            frameCount: frames,
            width,
            height,
            mimeType,
        };
    }

    public dispose(): void {
        this.port?.disconnect();
        this.port = null;
        this.track?.stop();
        this.track = null;
        this.canvas?.remove();
        this.canvas = null;
        this.ctx = null;
        this.recorder = null;
        this.chunks.length = 0;
        this.onChunk = null;
        this.frameCount = 0;
        this.chunkQueue = Promise.resolve();
        this.pendingDrawCount = 0;
        this.firstFrameReady = Promise.resolve();
        this.resolveFirstFrame = null;
        this.streamError = null;
    }
}

export const captureManager = new ScreenCaptureManager();

export function startCapture(
    tabId?: number,
    onChunk?: (bytes: Uint8Array) => boolean,
): Promise<CaptureAck | CaptureError> {
    return captureManager.start(tabId, onChunk);
}

export function stopCapture(): Promise<CaptureResult | CaptureError> {
    return captureManager.stop();
}

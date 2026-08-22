/**
 * Screen recording of the active tab running in the offscreen document.
 * Draws screencast frames onto an offscreen canvas and encodes via MediaRecorder.
 * Designed specifically for human visual verification, debugging, and feedback.
 */
import { errorMessage } from "../../libs/errorMessage.js";
import type { CaptureAck, CaptureError, CaptureResult, FrameMessage, PortAck } from "./types.js";

export type { CaptureAck, CaptureError, CaptureResult } from "./types.js";

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
    private onChunk: ((bytes: Uint8Array) => void) | null;
    private recordingStartedAt: number;
    private frameCount: number;
    private frameQueue: Promise<void>;
    private pendingDrawCount: number;

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
        this.pendingDrawCount = 0;
    }

    private async drawFrame(frame: FrameMessage): Promise<void> {
        if (!this.canvas || !this.ctx || !this.track) return;
        // Drop intermediate frame under heavy load to prevent memory accumulation
        if (this.pendingDrawCount > 3) return;

        this.pendingDrawCount++;
        try {
            const bitmap = await createImageBitmap(base64ToBlob(frame.data, "image/jpeg"));
            this.ctx.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
            bitmap.close();
            this.track.requestFrame();
            this.frameCount++;
        } finally {
            this.pendingDrawCount--;
        }
    }

    public isRecording(): boolean {
        return this.recorder !== null;
    }

    public async start(onChunk?: (bytes: Uint8Array) => void): Promise<CaptureAck | CaptureError> {
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

        const stream = canvas.captureStream(0);
        const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

        this.canvas = canvas;
        this.ctx = ctx;
        this.track = track;
        this.chunks = [];
        this.onChunk = onChunk ?? null;
        this.frameCount = 0;
        this.pendingDrawCount = 0;
        this.frameQueue = Promise.resolve();

        const mimeType = pickSupportedMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = async (e) => {
            if (e.data.size > 0) {
                if (this.onChunk) {
                    const buf = await e.data.arrayBuffer();
                    this.onChunk(new Uint8Array(buf));
                } else {
                    this.chunks.push(e.data);
                }
            }
        };
        this.recorder = recorder;

        const ack = await new Promise<PortAck>((resolve) => {
            const p = chrome.runtime.connect({ name: "capture-frames" });
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
        this.frameCount++;
        this.recordingStartedAt = Date.now();
        return { success: true, message: "Recording started." };
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
        const frames = this.frameCount;

        this.recorder = null;
        this.port = null;
        this.track = null;
        this.onChunk = null;

        finishedPort.disconnect();
        await this.frameQueue;

        if (wasStreamed) {
            if (finishedRecorder.state !== "inactive") {
                finishedRecorder.stop();
            }
            finishedTrack?.stop();
            this.dispose();
            return {
                success: true,
                format: "webm",
                isStreamed: true,
                durationMs,
                frameCount: frames,
            };
        }

        const mimeType = finishedRecorder.mimeType || "video/webm";
        const blob = await new Promise<Blob>((resolve) => {
            if (finishedRecorder.state === "inactive") {
                resolve(new Blob(this.chunks, { type: mimeType }));
                return;
            }
            finishedRecorder.onstop = () => resolve(new Blob(this.chunks, { type: mimeType }));
            finishedRecorder.stop();
        });
        finishedTrack?.stop();

        this.dispose();

        const dataBase64 = await blobToBase64(blob);
        return {
            success: true,
            format: "webm",
            dataBase64,
            durationMs,
            frameCount: frames,
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
        this.pendingDrawCount = 0;
    }
}

export const captureManager = new ScreenCaptureManager();

export function startCapture(onChunk?: (bytes: Uint8Array) => void): Promise<CaptureAck | CaptureError> {
    return captureManager.start(onChunk);
}

export function stopCapture(): Promise<CaptureResult | CaptureError> {
    return captureManager.stop();
}

// Screen recording of the active tab. Runs in the OFFSCREEN DOCUMENT, not
// the service worker — MediaRecorder/<canvas> need a real DOM context,
// which only the offscreen document has while also staying alive in MV3.
//
// Frames come from CDP's Page.startScreencast (relayed from
// lib/screencast.ts over a chrome.runtime.Port), not chrome.tabCapture,
// which needs a real user gesture an AI-driven recording can't provide.
// Each incoming JPEG frame is drawn onto an offscreen <canvas>, whose
// captureStream() feeds MediaRecorder.

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

interface FrameMessage {
    data: string;
    metadata: { deviceWidth: number; deviceHeight: number };
}
type PortAck = { success: true } | { error: string; hint: string };

export interface CaptureAck {
    [key: string]: unknown;
    success: true;
    message: string;
}

export interface CaptureResult {
    [key: string]: unknown;
    success: true;
    format: "webm";
    dataBase64: string;
    durationMs: number;
    frameCount: number;
}

export interface CaptureError {
    [key: string]: unknown;
    error: string;
    hint: string;
}

let port: chrome.runtime.Port | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let track: CanvasCaptureMediaStreamTrack | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordingStartedAt = 0;
let frameCount = 0;
// Serializes drawFrame calls so frames land on the canvas in arrival order
// — see the comment at its one call site in startCapture.
let frameQueue: Promise<void> = Promise.resolve();

// vp9 first (best compression), falling back for older Chrome builds that
// don't support it.
function pickSupportedMimeType(): string | undefined {
    for (const type of [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
    ]) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return undefined;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

async function drawFrame(frame: FrameMessage): Promise<void> {
    if (!canvas || !ctx || !track) return;
    // Never resize the canvas to the frame's actual dimensions, even though
    // they can drift slightly (window resize, DPI change) — WebM's
    // PixelWidth/Height are fixed from the first keyframe, so changing
    // canvas.width/height mid-recording produces a file most players can't
    // open. drawImage's destination rect scales every frame to fit instead.
    const bitmap = await createImageBitmap(
        base64ToBlob(frame.data, "image/jpeg"),
    );
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    console.log("[browsercontrol] drew frame", frameCount + 1);
    // captureStream(0) is manual mode — a frame only emits on requestFrame(),
    // so output rate tracks real screencast activity, not a fixed timer.
    track.requestFrame();
    frameCount++;
}

export async function startCapture(): Promise<CaptureAck | CaptureError> {
    if (recorder) {
        return {
            error: "Already recording",
            hint: "Call browser_session({action:\"stop_recording\"}) first, or ignore if you meant to keep recording — this call was a no-op.",
        };
    }

    canvas = document.createElement("canvas");
    // Matches screencast.ts's Page.startScreencast maxWidth/maxHeight so
    // frames arrive at or under this size — fixed for the whole recording,
    // see drawFrame's no-resize note.
    canvas.width = 1280;
    canvas.height = 900;
    // Must be attached to the document — an unattached <canvas> isn't on any
    // render path, and captureStream() on one grabs exactly one static frame
    // at creation and never updates (produces a recording that's technically
    // valid but effectively a single-frame thumbnail). Positioned off-screen
    // since the offscreen document is never shown to the user anyway.
    canvas.style.cssText = "position:fixed;left:-99999px;top:0;";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    if (!ctx) {
        canvas.remove();
        canvas = null;
        return {
            error: "Failed to create capture canvas",
            hint: "2D canvas context unavailable in the offscreen document — this shouldn't normally happen.",
        };
    }

    // Paint a placeholder frame immediately rather than leaving the track
    // empty until the first real CDP frame lands — a stop_recording called
    // very quickly after start could otherwise land on a recorder some
    // Chrome builds have already dropped to "inactive" for never having
    // received a frame.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const stream = canvas.captureStream(0);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

    chunks = [];
    frameCount = 0;
    frameQueue = Promise.resolve();
    const mimeType = pickSupportedMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    const ack = await new Promise<PortAck>((resolve) => {
        const p = chrome.runtime.connect({ name: "capture-frames" });
        port = p;
        let settled = false;
        p.onMessage.addListener((msg: FrameMessage | PortAck) => {
            if ("data" in msg) {
                // Frames can arrive faster than drawFrame's decode+draw
                // finishes — chaining onto frameQueue (instead of firing
                // each drawFrame independently) keeps them drawn in arrival
                // order. The .catch() is load-bearing: one rejected
                // drawFrame would otherwise leave frameQueue permanently
                // rejected, silently freezing every frame after it.
                frameQueue = frameQueue.then(() => drawFrame(msg)).catch((e) => {
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
        port?.disconnect();
        port = null;
        track = null;
        canvas.remove();
        canvas = null;
        ctx = null;
        recorder = null;
        return ack;
    }

    try {
        recorder.start(1000);
    } catch (e) {
        // Reset all state — leaving `recorder` set would permanently trip
        // the "Already recording" guard above on every future call.
        port?.disconnect();
        port = null;
        track = null;
        canvas.remove();
        canvas = null;
        ctx = null;
        recorder = null;
        return {
            error: "Failed to start recording",
            hint: errorMessage(e),
        };
    }
    // fillRect alone emits nothing on a manual-mode track — only
    // requestFrame() does, now that the recorder is actually listening.
    track.requestFrame();
    frameCount++;
    recordingStartedAt = Date.now();
    return { success: true, message: "Recording started." };
}

export async function stopCapture(): Promise<CaptureResult | CaptureError> {
    if (!recorder || !port) {
        return {
            error: "Not recording",
            hint: "Call browser_session({action:\"start_recording\"}) first.",
        };
    }
    const finishedRecorder = recorder;
    const finishedPort = port;
    const finishedTrack = track;
    recorder = null;
    port = null;
    track = null;

    // Triggers background.ts's port.onDisconnect -> Page.stopScreencast.
    // Wait for any already-queued frame to finish drawing first, or the
    // last moment of the recording gets cut early.
    finishedPort.disconnect();
    await frameQueue;

    const mimeType = finishedRecorder.mimeType || "video/webm";
    const blob = await new Promise<Blob>((resolve) => {
        // .stop() throws if the recorder is already "inactive" (the track
        // ended on its own — tab closed, canvas torn down) — its 'stop'
        // event already fired and won't again, so resolve from whatever
        // chunks landed instead of calling .stop() again.
        if (finishedRecorder.state === "inactive") {
            resolve(new Blob(chunks, { type: mimeType }));
            return;
        }
        finishedRecorder.onstop = () =>
            resolve(new Blob(chunks, { type: mimeType }));
        finishedRecorder.stop();
    });
    finishedTrack?.stop();

    const durationMs = Date.now() - recordingStartedAt;
    const frames = frameCount;
    chunks = [];
    frameCount = 0;
    canvas?.remove();
    canvas = null;
    ctx = null;

    const dataBase64 = await blobToBase64(blob);
    return {
        success: true,
        format: "webm",
        dataBase64,
        durationMs,
        frameCount: frames,
    };
}

// btoa() only accepts a binary string, and String.fromCharCode(...bytes)
// blows the call-stack argument limit well before a multi-MB video's worth
// of bytes — chunk it the same way any base64-a-large-buffer helper has to.
async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK_SIZE = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

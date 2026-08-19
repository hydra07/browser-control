// Screen recording of the active tab — separate concern from screenshot.ts
// (single frame) and, unlike everything else under extension/lib, this runs
// in the OFFSCREEN DOCUMENT, not the service worker: MediaRecorder and
// <canvas> don't exist in a service worker at all, only in a real DOM
// context, and the offscreen document is the only place in an MV3 extension
// that has both "stays alive" and "has DOM APIs".
//
// Frame source is CDP's Page.startScreencast (relayed from background.ts's
// lib/screencast.ts over a chrome.runtime.Port), NOT chrome.tabCapture.
// tabCapture.getMediaStreamId requires activeTab permission granted by a
// real user gesture (clicking the extension's toolbar icon) — an AI-driven
// recording triggered from the daemon has no such gesture, and fails with
// "Extension has not been invoked for the current page". Each incoming
// screencast frame (a JPEG) is drawn onto an offscreen <canvas>, whose
// captureStream() feeds MediaRecorder — same MediaRecorder/webm output as a
// real tabCapture stream would have produced, just sourced from CDP instead.

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
    // Deliberately NOT resizing the canvas to frame.metadata's
    // deviceWidth/deviceHeight here, even though they can differ slightly
    // frame to frame (window resize, DPI change) — setting canvas.width/
    // height mid-recording clears the canvas AND changes the resolution of
    // the MediaStreamTrack MediaRecorder is actively encoding. The WebM
    // container's PixelWidth/PixelHeight are fixed from the first keyframe;
    // a resolution change partway through produces a file most players
    // can't open at all, even though it still has a plausible size/duration
    // (this was the cause of a real "recording succeeds but the .webm won't
    // play" bug). drawImage's explicit destination rect below scales every
    // frame to the canvas's fixed size instead, so the encoded resolution
    // never moves for the life of one recording.
    const bitmap = await createImageBitmap(
        base64ToBlob(frame.data, "image/jpeg"),
    );
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    console.log("[browsercontrol] drew frame", frameCount + 1);
    // captureStream(0) below puts the track in manual mode — a video frame
    // is only emitted when explicitly requested, so the output frame rate
    // tracks real screencast activity instead of a fixed timer sampling a
    // possibly-stale canvas.
    track.requestFrame();
    frameCount++;
}

export async function startCapture(): Promise<CaptureAck | CaptureError> {
    if (recorder) {
        return {
            error: "Already recording",
            hint: "Call browser_stop_recording first, or ignore if you meant to keep recording — this call was a no-op.",
        };
    }

    canvas = document.createElement("canvas");
    // Matches lib/screencast.ts's Page.startScreencast maxWidth/maxHeight
    // cap, so a normal-sized viewport's frames arrive at (or under) this
    // canvas's own size and drawImage's scale-to-fit is a no-op or a minor
    // downscale, not a stretch. Fixed for the whole recording — see the
    // no-resize note in drawFrame for why.
    canvas.width = 1280;
    canvas.height = 900;
    // Must actually be in the document tree, not just constructed — an
    // unattached <canvas> is not on any render/compositing path, and
    // captureStream() on one reliably grabs exactly one static frame at
    // creation and never updates again (this was the actual cause of a
    // recording that "looked like a picture" — a thumbnail with no
    // scrubbable timeline: technically valid duration, effectively 1 frame).
    // Positioned off in space rather than hidden — the offscreen document is
    // never shown to the user either way, this is purely about being a real
    // rendered element.
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

    // Paint one placeholder frame immediately instead of leaving the canvas
    // (and therefore the track) with zero content until the first real CDP
    // screencast frame lands. If stop_recording is called quickly after
    // start_recording — before that first frame has round-tripped through
    // Page.startScreencast + the capture-frames port — the recorder would
    // otherwise have never received a single frame, which some Chrome builds
    // treat as reason enough to drop it to "inactive" on their own well
    // before an explicit .stop() call.
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
                // screencastFrameAck (screencast.ts) fires right after the
                // frame is posted to this port, not after it's actually
                // drawn — so frames can arrive faster than drawFrame's
                // decode+draw finishes. Chaining onto frameQueue instead of
                // firing each drawFrame independently keeps them drawn in
                // arrival order even if one frame's JPEG decodes slower than
                // the next one's; without this a later frame could land on
                // the canvas before an earlier one, visibly reordering
                // motion in the recording.
                //
                // The .catch() here is load-bearing, not decorative: without
                // it, one rejected drawFrame() (a malformed frame, a decode
                // error) leaves frameQueue itself permanently rejected —
                // every later frame chains onto it with .then(), which never
                // runs once the chain it's hanging off is rejected. That
                // silently froze the recording at whatever the last
                // successfully-drawn frame was (in practice: frame 0, the
                // black placeholder) for the rest of the take.
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
        // Leaving `recorder` set to a MediaRecorder that never actually
        // started would permanently trip the "Already recording" guard
        // above on every future call — reset all state so a retry can
        // actually retry.
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
    // Push that placeholder frame now that the recorder is actually
    // listening — fillRect alone doesn't emit anything on a manual-mode
    // (captureStream(0)) track, only requestFrame() does.
    track.requestFrame();
    frameCount++;
    recordingStartedAt = Date.now();
    return { success: true, message: "Recording started." };
}

export async function stopCapture(): Promise<CaptureResult | CaptureError> {
    if (!recorder || !port) {
        return {
            error: "Not recording",
            hint: "Call browser_start_recording first.",
        };
    }
    const finishedRecorder = recorder;
    const finishedPort = port;
    const finishedTrack = track;
    recorder = null;
    port = null;
    track = null;

    // Triggers background.ts's port.onDisconnect -> Page.stopScreencast, so
    // no more frames arrive after this point. Any frame already queued
    // still needs to finish drawing (and call requestFrame()) before the
    // recorder stops, or the last moment of the recording gets cut early.
    finishedPort.disconnect();
    await frameQueue;

    const mimeType = finishedRecorder.mimeType || "video/webm";
    const blob = await new Promise<Blob>((resolve) => {
        // .stop() throws InvalidStateError if the recorder is already
        // "inactive" — which happens if the underlying track ended on its
        // own (tab closed, canvas torn down) before this call. In that case
        // its 'stop' event already fired (and won't fire again), so calling
        // .stop() again would both throw AND leave this promise waiting on
        // an event that's never coming. Resolve directly from whatever
        // chunks landed instead.
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

import type { Protocol } from "devtools-protocol";
import { evalOnPage, sendCommand } from "../../libs/cdp.js";
import type { AnnotatedScreenshotResult, ScreenshotError, ScreenshotResult } from "./types.js";

export type { AnnotatedScreenshotResult, ScreenshotError, ScreenshotResult } from "./types.js";

/** Injects numbered annotation boxes over interactive elements on the page. */
export function drawAnnotationOverlay(boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
    const old = document.getElementById("__bc_annotate_overlay__");
    if (old) old.remove();
    if (!document.getElementById("__bc_annotate_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_annotate_style__";
        style.textContent =
            "@keyframes __bc_pop__ { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }";
        document.documentElement.appendChild(style);
    }
    const container = document.createElement("div");
    container.id = "__bc_annotate_overlay__";
    container.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(container);
    boxes.forEach((b, idx) => {
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:1.5px solid rgba(99,102,241,0.85);border-radius:6px;box-sizing:border-box;background:rgba(99,102,241,0.07);box-shadow:0 0 0 1px rgba(255,255,255,0.5) inset,0 2px 10px rgba(99,102,241,0.25);transform-origin:center;animation:__bc_pop__ 0.22s ease-out ${idx * 0.012}s both;`;
        const label = document.createElement("div");
        label.textContent = String(b.id);
        label.style.cssText =
            'position:absolute;top:-10px;left:-10px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:linear-gradient(135deg,#a78bfa,#6366f1);color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;box-shadow:0 2px 6px rgba(99,102,241,0.5),0 0 0 2px #fff;';
        box.appendChild(label);
        container.appendChild(box);
    });
}

/** Removes the injected annotation overlay from the page. */
export function removeAnnotationOverlay() {
    document.getElementById("__bc_annotate_overlay__")?.remove();
}

/** Captures a viewport or full-page screenshot via CDP. */
export async function captureScreenshot(
    target: chrome.debugger.Debuggee,
    opts: { format?: "jpeg" | "png"; quality?: number; fullPage?: boolean },
): Promise<ScreenshotResult | ScreenshotError> {
    const format = opts.format === "png" ? "png" : "jpeg";
    const params: Protocol.Page.CaptureScreenshotRequest = { format };
    if (format === "jpeg") params.quality = opts.quality ?? 80;

    if (opts.fullPage) {
        const metrics = await sendCommand(target, "Page.getLayoutMetrics");
        const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
        if (contentSize) {
            params.clip = {
                x: 0,
                y: 0,
                width: contentSize.width,
                height: contentSize.height,
                scale: 1,
            };
            params.captureBeyondViewport = true;
        }
    }

    const res = await sendCommand(target, "Page.captureScreenshot", params);
    if (!res?.data) {
        return {
            error: "Failed to capture screenshot",
            hint: "The page or debugger session may be in a bad state; try navigating again.",
        };
    }
    return { success: true, format, dataBase64: res.data };
}

/** Draws numbered boxes over elements, captures screenshot, and clears annotations. */
export async function captureAnnotatedScreenshot(
    target: chrome.debugger.Debuggee,
    boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>,
): Promise<AnnotatedScreenshotResult | ScreenshotError> {
    await evalOnPage(target, `(${drawAnnotationOverlay.toString()})(${JSON.stringify(boxes)})`);

    const shot = await sendCommand(target, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
    });

    await evalOnPage(target, `(${removeAnnotationOverlay.toString()})()`);

    if (!shot?.data) {
        return {
            error: "Failed to capture annotated screenshot",
            hint: "The page or debugger session may be in a bad state; try navigating again.",
        };
    }
    return { format: "jpeg", dataBase64: shot.data };
}

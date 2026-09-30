import type { Protocol } from "devtools-protocol";
import { evalOnPage, evalOnPageWithResult, quadToBox, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import {
    AUTO_ZOOM_TARGET_PX,
    DEFAULT_ELEMENT_PADDING,
    DEFAULT_MAX_DIMENSION,
    MAX_AUTO_ZOOM,
    MAX_STITCH_STEPS,
    MAX_ZOOM,
    VISIBLE_CAPTURE_INTERVAL_MS,
} from "./constants.js";
import type {
    AnnotatedScreenshotResult,
    CaptureMode,
    ScreenshotError,
    ScreenshotFormat,
    ScreenshotOptions,
    ScreenshotResult,
} from "./types.js";

export type {
    AnnotatedScreenshotResult,
    ScreenshotError,
    ScreenshotOptions,
    ScreenshotResult,
} from "./types.js";

/** Injects numbered annotation boxes over interactive elements on the page. */
export function drawAnnotationOverlay(boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
    const old = document.getElementById("__bc_annotate_overlay__");
    if (old) old.remove();
    const container = document.createElement("div");
    container.id = "__bc_annotate_overlay__";
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
        "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
    document.documentElement.appendChild(container);
    boxes.forEach((b) => {
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:1.5px solid rgba(99,102,241,0.85);border-radius:6px;box-sizing:border-box;background:rgba(99,102,241,0.07);box-shadow:0 0 0 1px rgba(255,255,255,0.5) inset,0 2px 10px rgba(99,102,241,0.25);`;
        const label = document.createElement("div");
        label.textContent = String(b.id);
        const topOffset = b.y < 12 ? 0 : -10;
        const leftOffset = b.x < 12 ? 0 : -10;
        label.style.cssText = `position:absolute;top:${topOffset}px;left:${leftOffset}px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:linear-gradient(135deg,#a78bfa,#6366f1);color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;box-shadow:0 2px 6px rgba(99,102,241,0.5),0 0 0 2px #fff;`;
        box.appendChild(label);
        container.appendChild(box);
    });
}

/** Removes the injected annotation overlay from the page. */
export function removeAnnotationOverlay() {
    document.getElementById("__bc_annotate_overlay__")?.remove();
}

/**
 * Chrome's compositor produces no frames for a background tab or a minimized
 * window, so Page.captureScreenshot hangs until the CDP timeout there. This
 * makes the tab the active one in its window (without stealing OS focus from
 * whatever window the user is in) and returns a function that puts the
 * previously active tab / minimized state back once the capture is done.
 */
async function bringTabToFront(tabId: number): Promise<() => Promise<void>> {
    let previousTabId: number | undefined;
    let minimizedWindowId: number | undefined;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
            const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
            previousTabId = active?.id;
            await chrome.tabs.update(tabId, { active: true });
        }
        const win = await chrome.windows.get(tab.windowId);
        if (win.state === "minimized") {
            minimizedWindowId = tab.windowId;
            await chrome.windows.update(tab.windowId, { state: "normal" });
        }
    } catch {}
    if (previousTabId != null || minimizedWindowId != null) await waitForFrames({ tabId }, 2);
    return async () => {
        if (previousTabId != null) await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
        if (minimizedWindowId != null) {
            await chrome.windows.update(minimizedWindowId, { state: "minimized" }).catch(() => {});
        }
    };
}

/**
 * BrowserControl's own on-page UI would otherwise end up in the image: the CDP
 * Overlay highlight that find/click flash on a target, and the fake cursor,
 * ripples and badges (plain DOM). Hides both for the capture; the numbered
 * boxes of an annotated capture are kept.
 */
async function hideOwnOverlays(target: chrome.debugger.Debuggee): Promise<() => Promise<void>> {
    await sendCommand(target, "Overlay.hideHighlight").catch(() => {});
    await evalOnPage(
        target,
        `(() => { if (document.getElementById("__bc_capture_hide__")) return; const s = document.createElement("style"); s.id = "__bc_capture_hide__"; s.textContent = '[id^="__bc_"]:not(#__bc_annotate_overlay__):not(#__bc_capture_hide__), [class^="__bc_"] { visibility: hidden !important; }'; document.documentElement.appendChild(s); })()`,
    );
    return () => evalOnPage(target, `document.getElementById("__bc_capture_hide__")?.remove()`);
}

/** Resolves after n animation frames (bounded), so style/scroll changes are painted before a capture. */
async function waitForFrames(target: chrome.debugger.Debuggee, n: number): Promise<void> {
    await evalOnPage(
        target,
        `new Promise((resolve) => { let left = ${n}; const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); setTimeout(resolve, 500); })`,
        true,
    );
}

interface ScrollerInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    scrollHeight: number;
    scrollTop: number;
}

interface PageCaptureMetrics {
    dpr: number;
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    contentWidth: number;
    contentHeight: number;
    scroller?: ScrollerInfo;
}

/**
 * Measures the page in CSS px. With `prepare` (full-page), it also forces lazy
 * images, walks the page once so IntersectionObserver loaders fire, and waits
 * (bounded) for image decode and web fonts. When the document itself doesn't
 * scroll, it looks for the app-style inner scroll container (chat logs,
 * mail lists, docs editors) and tags it with data-bc-scroller for stitching.
 */
function measurePageScript(prepare: boolean): string {
    const fn = async (fullPage: boolean) => {
        const bounded = <T>(p: Promise<T>, ms: number) =>
            Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
        const doc = document.documentElement;
        const body = document.body;
        if (fullPage) {
            document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => {
                img.loading = "eager";
            });
            document.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
                if (!img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src;
            });
            const originX = window.scrollX;
            const originY = window.scrollY;
            const total = Math.max(doc.scrollHeight, body?.scrollHeight ?? 0);
            const step = Math.max(window.innerHeight || 800, 400);
            // "instant" overrides a page-level scroll-behavior:smooth that would otherwise leave us mid-animation.
            for (let y = step, n = 0; y < total && n < 15; y += step, n++) {
                window.scrollTo({ left: 0, top: y, behavior: "instant" });
                await new Promise((r) => setTimeout(r, 40));
            }
            window.scrollTo({ left: originX, top: originY, behavior: "instant" });
            const pending = Array.from(document.images)
                .filter((img) => !img.complete)
                .slice(0, 50);
            await bounded(Promise.all(pending.map((img) => img.decode().catch(() => {}))), 1500);
            if (document.fonts?.ready)
                await bounded(
                    document.fonts.ready.catch(() => {}),
                    1000,
                );
        }
        const viewportWidth = doc.clientWidth || window.innerWidth;
        const viewportHeight = doc.clientHeight || window.innerHeight;
        const scrollsX =
            doc.scrollWidth > viewportWidth + 1 &&
            getComputedStyle(doc).overflowX !== "hidden" &&
            (!body || getComputedStyle(body).overflowX !== "hidden");
        const contentWidth = scrollsX ? Math.max(doc.scrollWidth, body?.scrollWidth ?? 0) : viewportWidth;
        const contentHeight = Math.max(doc.scrollHeight, body?.scrollHeight ?? 0, viewportHeight);
        let scroller: ScrollerInfo | undefined;
        document.querySelectorAll("[data-bc-scroller]").forEach((el) => el.removeAttribute("data-bc-scroller"));
        if (fullPage && contentHeight <= viewportHeight + 2) {
            let best: Element | null = null;
            let bestArea = 0;
            const all = document.body ? document.body.getElementsByTagName("*") : [];
            for (let i = 0; i < all.length && i < 20000; i++) {
                const el = all[i];
                if (el.scrollHeight <= el.clientHeight + 20) continue;
                if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
                const r = el.getBoundingClientRect();
                const w = Math.max(0, Math.min(r.right, viewportWidth) - Math.max(r.left, 0));
                const h = Math.max(0, Math.min(r.bottom, viewportHeight) - Math.max(r.top, 0));
                if (w * h > bestArea) {
                    best = el;
                    bestArea = w * h;
                }
            }
            if (best && bestArea > viewportWidth * viewportHeight * 0.2) {
                best.setAttribute("data-bc-scroller", "1");
                const r = best.getBoundingClientRect();
                scroller = {
                    x: Math.max(0, r.left) + best.clientLeft,
                    y: Math.max(0, r.top) + best.clientTop,
                    width: best.clientWidth,
                    height: Math.min(best.clientHeight, viewportHeight - Math.max(0, r.top)),
                    scrollHeight: best.scrollHeight,
                    scrollTop: best.scrollTop,
                };
            }
        }
        return {
            dpr: window.devicePixelRatio || 1,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            viewportWidth,
            viewportHeight,
            contentWidth: Math.ceil(contentWidth),
            contentHeight: Math.ceil(contentHeight),
            scroller,
        };
    };
    return `(${fn.toString()})(${prepare})`;
}

async function measurePage(target: chrome.debugger.Debuggee, prepare: boolean): Promise<PageCaptureMetrics | null> {
    return (await evalOnPageWithResult<PageCaptureMetrics>(target, measurePageScript(prepare), true)) ?? null;
}

interface PageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * One Page.captureScreenshot of a rectangle in page (document) CSS px.
 * The output is width*scale*devicePixelRatio device px, so scale = zoom / dpr
 * makes the image exactly `zoom` px per CSS px on any display.
 */
async function captureRect(
    target: chrome.debugger.Debuggee,
    rect: PageRect,
    zoom: number,
    dpr: number,
    format: ScreenshotFormat,
    quality: number,
    beyondViewport: boolean,
): Promise<string | null> {
    const params: Protocol.Page.CaptureScreenshotRequest = {
        format,
        clip: { ...roundRect(rect), scale: zoom / dpr },
        captureBeyondViewport: beyondViewport,
        fromSurface: true,
    };
    if (format !== "png") params.quality = quality;
    const res = await sendCommand(target, "Page.captureScreenshot", params, { retryOnTimeout: true });
    return res?.data ?? null;
}

function roundRect(r: PageRect): PageRect {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    return {
        x,
        y,
        width: Math.max(1, Math.ceil(r.x + r.width) - x),
        height: Math.max(1, Math.ceil(r.y + r.height) - y),
    };
}

function mimeFor(format: ScreenshotFormat): string {
    return format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
}

function base64ToBlob(data: string, type: string): Blob {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/**
 * Full-page capture for pages whose document doesn't scroll but an inner
 * container does: scroll the container chunk by chunk, capture its visible
 * rect each time, and stitch the chunks on an OffscreenCanvas.
 */
async function captureScrollContainer(
    target: chrome.debugger.Debuggee,
    metrics: PageCaptureMetrics,
    scroller: ScrollerInfo,
    zoom: number,
    format: ScreenshotFormat,
    quality: number,
    maxDimension: number,
): Promise<{ data: string; height: number; truncated: boolean } | null> {
    const total = Math.min(scroller.scrollHeight, Math.floor(maxDimension / zoom));
    const canvas = new OffscreenCanvas(Math.round(scroller.width * zoom), Math.round(total * zoom));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const scrollTo = (top: number) =>
        evalOnPageWithResult<number>(
            target,
            `(async () => { const el = document.querySelector("[data-bc-scroller]"); if (!el) return -1; el.scrollTo({ top: ${top}, behavior: "instant" }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return el.scrollTop; })()`,
            true,
        );
    try {
        for (let step = 0, top = 0; step < MAX_STITCH_STEPS && top < total; step++, top += scroller.height) {
            const actual = await scrollTo(top);
            if (actual == null || actual < 0) return null;
            const chunk = await captureRect(
                target,
                {
                    x: scroller.x + metrics.scrollX,
                    y: scroller.y + metrics.scrollY,
                    width: scroller.width,
                    height: scroller.height,
                },
                zoom,
                metrics.dpr,
                "png",
                100,
                false,
            );
            if (!chunk) return null;
            const bitmap = await createImageBitmap(base64ToBlob(chunk, "image/png"));
            ctx.drawImage(bitmap, 0, Math.round(actual * zoom));
            bitmap.close();
            if (actual + scroller.height >= scroller.scrollHeight) break;
        }
    } finally {
        await scrollTo(scroller.scrollTop);
        await evalOnPage(target, `document.querySelector("[data-bc-scroller]")?.removeAttribute("data-bc-scroller")`);
    }
    const blob = await canvas.convertToBlob({ type: mimeFor(format), quality: quality / 100 });
    return { data: await blobToBase64(blob), height: total, truncated: scroller.scrollHeight > total };
}

/** Auto zoom for element/clip captures: small regions are magnified toward ~AUTO_ZOOM_TARGET_PX on the long edge. */
function autoZoom(width: number, height: number): number {
    const longest = Math.max(width, height, 1);
    return Math.max(1, Math.min(MAX_AUTO_ZOOM, Math.floor((AUTO_ZOOM_TARGET_PX / longest) * 4) / 4));
}

let lastVisibleCaptureAt = 0;

/** chrome.tabs.captureVisibleTab of the tab's window, spaced out to stay under Chrome's 2-calls-per-second quota. */
async function captureVisible(windowId: number): Promise<ImageBitmap> {
    const wait = lastVisibleCaptureAt + VISIBLE_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastVisibleCaptureAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return await createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function captureVisibleAsJpeg(tabId: number): Promise<string> {
    const { windowId } = await chrome.tabs.get(tabId);
    const bitmap = await captureVisible(windowId);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return blobToBase64(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
}

interface VisibleCaptureRequest {
    mode: CaptureMode;
    /** Page-coordinate CSS rect for element/clip/viewport modes. */
    rect: PageRect;
    fullPage: boolean;
    zoom?: number;
    format: ScreenshotFormat;
    quality: number;
    maxDimension: number;
}

/**
 * Capture path for tabs with browser zoom ≠ 100% (Ctrl +/−). There,
 * Page.captureScreenshot mixes CSS px and zoomed px in its clip handling, so
 * captures come back with the page shrunk into a corner of a white canvas or
 * tiled. This path uses exactly what is on screen instead: captureVisibleTab,
 * with the CSS→screen factor measured from the returned bitmap, then crops
 * (element/clip) or scrolls and stitches (full page: document or inner scroll
 * container) on an OffscreenCanvas. The user's zoom level is left alone.
 */
async function captureViaVisibleTab(
    target: chrome.debugger.Debuggee,
    tabId: number,
    metrics: PageCaptureMetrics,
    req: VisibleCaptureRequest,
): Promise<ScreenshotResult | ScreenshotError> {
    const { windowId } = await chrome.tabs.get(tabId);
    const pageZoom = Math.round((await chrome.tabs.getZoom(tabId).catch(() => 1)) * 100) / 100;
    const first = await captureVisible(windowId);
    const factor = first.width / metrics.viewportWidth;
    const encode = async (canvas: OffscreenCanvas) =>
        blobToBase64(await canvas.convertToBlob({ type: mimeFor(req.format), quality: req.quality / 100 }));

    if (!req.fullPage) {
        const vx = Math.max(0, req.rect.x - metrics.scrollX);
        const vy = Math.max(0, req.rect.y - metrics.scrollY);
        const vw = Math.max(1, Math.min(req.rect.width, metrics.viewportWidth - vx));
        const vh = Math.max(1, Math.min(req.rect.height, metrics.viewportHeight - vy));
        const onScreenW = vw * factor;
        const onScreenH = vh * factor;
        const zoom =
            req.zoom != null && req.zoom > 0
                ? Math.min(req.zoom, MAX_ZOOM)
                : req.mode === "element" || req.mode === "clip"
                  ? autoZoom(onScreenW, onScreenH)
                  : 1;
        const canvas = new OffscreenCanvas(Math.round(onScreenW * zoom), Math.round(onScreenH * zoom));
        canvas
            .getContext("2d")
            ?.drawImage(first, vx * factor, vy * factor, onScreenW, onScreenH, 0, 0, canvas.width, canvas.height);
        first.close();
        return {
            success: true,
            format: req.format,
            mode: req.mode,
            width: Math.round(vw),
            height: Math.round(vh),
            zoom,
            pageZoom,
            ...(vw < req.rect.width - 1 || vh < req.rect.height - 1 ? { truncated: true } : {}),
            dataBase64: await encode(canvas),
        };
    }

    const zoom = req.zoom != null && req.zoom > 0 ? Math.min(req.zoom, MAX_ZOOM) : 1;
    const scroller = metrics.contentHeight <= metrics.viewportHeight + 2 ? metrics.scroller : undefined;
    const region = scroller
        ? { x: scroller.x, y: scroller.y, width: scroller.width, height: scroller.height }
        : { x: 0, y: 0, width: metrics.viewportWidth, height: metrics.viewportHeight };
    const totalCss = scroller ? scroller.scrollHeight : metrics.contentHeight;
    const scale = factor * zoom;
    const cappedCss = Math.min(totalCss, Math.floor(req.maxDimension / scale));
    const canvas = new OffscreenCanvas(Math.round(region.width * scale), Math.round(cappedCss * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        first.close();
        return { error: "Canvas unavailable for stitching", hint: "Retry without --full." };
    }

    const frames = "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));";
    const scrollScript = (top: number) =>
        scroller
            ? `(async () => { const el = document.querySelector("[data-bc-scroller]"); if (!el) return null; el.scrollTo({ top: ${top}, behavior: "instant" }); ${frames} return el.scrollTop; })()`
            : `(async () => { window.scrollTo({ left: ${metrics.scrollX}, top: ${top}, behavior: "instant" }); ${frames} return window.scrollY; })()`;
    // Fixed/sticky bars would be repeated in every chunk; they stay visible in the first one only.
    const hideFixed = `(() => { for (const el of document.body.getElementsByTagName("*")) { const p = getComputedStyle(el).position; if (p === "fixed" || p === "sticky") { el.setAttribute("data-bc-fixed", el.style.visibility); el.style.visibility = "hidden"; } } })()`;
    const showFixed = `document.querySelectorAll("[data-bc-fixed]").forEach((el) => { el.style.visibility = el.getAttribute("data-bc-fixed"); el.removeAttribute("data-bc-fixed"); })`;
    const originTop = scroller ? scroller.scrollTop : metrics.scrollY;
    first.close();
    try {
        for (let step = 0, top = 0; step < MAX_STITCH_STEPS && top < cappedCss; step++, top += region.height) {
            const actual = await evalOnPageWithResult<number>(target, scrollScript(top), true);
            if (actual == null) break;
            if (step === 1 && !scroller) await evalOnPage(target, hideFixed);
            const shot = await captureVisible(windowId);
            ctx.drawImage(
                shot,
                region.x * factor,
                region.y * factor,
                region.width * factor,
                region.height * factor,
                0,
                Math.round(actual * scale),
                region.width * scale,
                region.height * scale,
            );
            shot.close();
            if (actual + region.height >= totalCss) break;
        }
    } finally {
        await evalOnPage(target, showFixed);
        await evalOnPageWithResult(target, scrollScript(originTop), true);
        if (scroller) {
            await evalOnPage(
                target,
                `document.querySelector("[data-bc-scroller]")?.removeAttribute("data-bc-scroller")`,
            );
        }
    }
    return {
        success: true,
        format: req.format,
        mode: scroller ? "scroll-container" : "full",
        width: Math.round(region.width),
        height: Math.round(cappedCss),
        zoom,
        pageZoom,
        ...(cappedCss < totalCss ? { truncated: true } : {}),
        dataBase64: await encode(canvas),
    };
}

/** Viewport, full-page (document or inner scroll container), element, or clip capture, normalised to CSS px × zoom. */
export async function captureScreenshot(
    target: chrome.debugger.Debuggee,
    opts: ScreenshotOptions,
): Promise<ScreenshotResult | ScreenshotError> {
    if (target.tabId == null) return { error: "Screenshot requires a tab target", hint: "Pass --tab <id>." };
    const format: ScreenshotFormat = opts.format === "png" || opts.format === "webp" ? opts.format : "jpeg";
    const quality = Math.max(1, Math.min(100, opts.quality ?? 80));
    const maxDimension = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;
    const restore = await bringTabToFront(target.tabId);
    const showOverlays = await hideOwnOverlays(target);
    try {
        if (opts.nodeId != null) {
            await sendCommand(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: opts.nodeId }).catch(() => {});
        }
        const fullPage = opts.fullPage === true && opts.nodeId == null && !opts.clip;
        const metrics = await measurePage(target, fullPage);
        if (!metrics) {
            return {
                error: "Could not measure the page for capture",
                hint: "The page may still be loading or blocks script evaluation; retry after `browsercontrol wait`.",
            };
        }

        let mode: CaptureMode = "viewport";
        let rect: PageRect = {
            x: metrics.scrollX,
            y: metrics.scrollY,
            width: metrics.viewportWidth,
            height: metrics.viewportHeight,
        };
        if (opts.nodeId != null) {
            const model = await sendCommand(target, "DOM.getBoxModel", { backendNodeId: opts.nodeId }).catch(
                () => null,
            );
            if (!model?.model) {
                return {
                    error: "Failed to resolve element bounds",
                    hint: "The node id may be stale or the element is not rendered (display:none). Take a fresh snapshot.",
                };
            }
            const box = quadToBox(model.model.border);
            const pad = opts.padding ?? DEFAULT_ELEMENT_PADDING;
            mode = "element";
            rect = {
                x: box.x + metrics.scrollX - pad,
                y: box.y + metrics.scrollY - pad,
                width: box.w + pad * 2,
                height: box.h + pad * 2,
            };
        } else if (opts.clip) {
            mode = "clip";
            rect = {
                x: opts.clip.x + metrics.scrollX,
                y: opts.clip.y + metrics.scrollY,
                width: opts.clip.width,
                height: opts.clip.height,
            };
        }

        const pageZoom = await chrome.tabs.getZoom(target.tabId).catch(() => 1);
        if (Math.abs(pageZoom - 1) > 0.01) {
            return await captureViaVisibleTab(target, target.tabId, metrics, {
                mode,
                rect,
                fullPage,
                zoom: opts.zoom,
                format,
                quality,
                maxDimension,
            });
        }

        const requestedZoom = opts.zoom != null && opts.zoom > 0 ? Math.min(opts.zoom, MAX_ZOOM) : undefined;
        if (fullPage && metrics.contentHeight <= metrics.viewportHeight + 2 && metrics.scroller) {
            const zoom = requestedZoom ?? 1;
            const stitched = await captureScrollContainer(
                target,
                metrics,
                metrics.scroller,
                zoom,
                format,
                quality,
                maxDimension,
            );
            if (stitched) {
                return {
                    success: true,
                    format,
                    mode: "scroll-container",
                    width: metrics.scroller.width,
                    height: stitched.height,
                    zoom,
                    ...(stitched.truncated ? { truncated: true } : {}),
                    dataBase64: stitched.data,
                };
            }
        }

        let truncated = false;
        if (fullPage) {
            mode = "full";
            rect = { x: 0, y: 0, width: metrics.contentWidth, height: metrics.contentHeight };
        }
        const zoom = requestedZoom ?? (mode === "element" || mode === "clip" ? autoZoom(rect.width, rect.height) : 1);
        // Chrome renders captures into one GPU texture; past ~16k device px it returns blank or fails, so cap instead.
        const maxCss = Math.floor(maxDimension / zoom);
        if (rect.height > maxCss) {
            rect.height = maxCss;
            truncated = true;
        }
        rect.width = Math.min(rect.width, maxCss);
        const viewportRight = metrics.scrollX + metrics.viewportWidth;
        const viewportBottom = metrics.scrollY + metrics.viewportHeight;
        const beyond =
            rect.x < metrics.scrollX ||
            rect.y < metrics.scrollY ||
            rect.x + rect.width > viewportRight + 1 ||
            rect.y + rect.height > viewportBottom + 1;
        const data = await captureRect(target, rect, zoom, metrics.dpr, format, quality, beyond);
        if (!data) {
            return {
                error: "Failed to capture screenshot",
                hint: "The debugger session may be in a bad state; retry, or `browsercontrol reload` the page.",
            };
        }
        return {
            success: true,
            format,
            mode,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            zoom,
            ...(truncated ? { truncated: true } : {}),
            dataBase64: data,
        };
    } catch (e) {
        return {
            error: `Screenshot failed: ${errorMessage(e)}`,
            hint: "If this is a background tab or minimized window, bring it up once; otherwise retry.",
        };
    } finally {
        await showOverlays();
        await restore();
    }
}

/** Draws numbered boxes over elements, captures the viewport at CSS size, and clears the annotations. */
export async function captureAnnotatedScreenshot(
    target: chrome.debugger.Debuggee,
    boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>,
): Promise<AnnotatedScreenshotResult | ScreenshotError> {
    if (target.tabId == null) return { error: "Screenshot requires a tab target", hint: "Pass --tab <id>." };
    const restore = await bringTabToFront(target.tabId);
    const showOverlays = await hideOwnOverlays(target);
    try {
        const metrics = await measurePage(target, false);
        await evalOnPage(target, `(${drawAnnotationOverlay.toString()})(${JSON.stringify(boxes)})`);
        await waitForFrames(target, 1);
        const pageZoom = await chrome.tabs.getZoom(target.tabId).catch(() => 1);
        // Same browser-zoom problem as captureScreenshot: take the on-screen pixels instead of a CDP clip.
        const data = !metrics
            ? null
            : Math.abs(pageZoom - 1) > 0.01
              ? await captureVisibleAsJpeg(target.tabId)
              : await captureRect(
                    target,
                    {
                        x: metrics.scrollX,
                        y: metrics.scrollY,
                        width: metrics.viewportWidth,
                        height: metrics.viewportHeight,
                    },
                    1,
                    metrics.dpr,
                    "jpeg",
                    80,
                    false,
                );
        await evalOnPage(target, `(${removeAnnotationOverlay.toString()})()`);
        if (!data) {
            return {
                error: "Failed to capture annotated screenshot",
                hint: "The page or debugger session may be in a bad state; try navigating again.",
            };
        }
        return { format: "jpeg", dataBase64: data };
    } finally {
        await showOverlays();
        await restore();
    }
}

import type { Protocol } from "devtools-protocol";
import { evalOnPage, evalOnPageWithResult, sendCommand } from "../../libs/cdp.js";
import type { AnnotatedScreenshotResult, ScreenshotError, ScreenshotResult } from "./types.js";

export type { AnnotatedScreenshotResult, ScreenshotError, ScreenshotResult } from "./types.js";

/** Injects numbered annotation boxes over interactive elements on the page. */
export function drawAnnotationOverlay(boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
    const old = document.getElementById("__bc_annotate_overlay__");
    if (old) old.remove();
    const container = document.createElement("div");
    container.id = "__bc_annotate_overlay__";
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

/** Ensure the target tab is active and its window unminimized so Chrome's compositor renders frames for capture. */
async function ensureTabActiveForCapture(target: chrome.debugger.Debuggee): Promise<void> {
    if (target.tabId == null) return;
    try {
        const tab = await chrome.tabs.get(target.tabId);
        if (!tab.active) {
            await chrome.tabs.update(target.tabId, { active: true });
        }
        if (tab.windowId != null) {
            const win = await chrome.windows.get(tab.windowId);
            if (win.state === "minimized") {
                await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
            } else if (!win.focused) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
        }
        await new Promise((r) => setTimeout(r, 100));
    } catch {}
}

interface PageCaptureMetrics {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    dpr: number;
}

/** Prepares page content for capture: forces lazy images to eager, decodes pending images, waits for web fonts, and calculates exact CSS pixel dimensions. */
async function preparePageForCapture(
    target: chrome.debugger.Debuggee,
    isFullPage: boolean,
): Promise<PageCaptureMetrics | null> {
    try {
        const res = await evalOnPageWithResult<PageCaptureMetrics>(
            target,
            `(${(
                () => {
                    return (async (fullPage: boolean) => {
                        // 1. Force native loading="lazy" images to load eagerly
                        document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => {
                            img.loading = "eager";
                        });

                        // 2. Trigger common data-src / data-srcset lazy load libraries (Lozad, LazySizes, etc.)
                        document
                            .querySelectorAll("img[data-src], img[data-srcset], source[data-srcset]")
                            .forEach((el) => {
                                const img = el as HTMLImageElement | HTMLSourceElement;
                                if (img.dataset.src && !("src" in img && img.src)) {
                                    (img as HTMLImageElement).src = img.dataset.src;
                                }
                                if (img.dataset.srcset && !img.srcset) {
                                    img.srcset = img.dataset.srcset;
                                }
                            });

                        // 3. For fullPage, scroll down through document to trigger IntersectionObservers and dynamic loaders
                        if (fullPage) {
                            const origX = window.scrollX;
                            const origY = window.scrollY;
                            const docEl = document.documentElement;
                            const bodyEl = document.body;
                            const totalHeight = Math.max(docEl.scrollHeight, bodyEl ? bodyEl.scrollHeight : 0);
                            const step = Math.max(window.innerHeight || 800, 400);

                            // Cap to at most 15 steps (~15,000px) to prevent hanging on infinite scroll
                            const maxSteps = 15;
                            let stepsTaken = 0;
                            for (let y = step; y < totalHeight && stepsTaken < maxSteps; y += step) {
                                window.scrollTo(0, y);
                                stepsTaken++;
                                await new Promise((r) => setTimeout(r, 40));
                            }

                            // Scroll back to initial position
                            window.scrollTo(origX, origY);
                            await new Promise((r) => setTimeout(r, 50));
                        }

                        // 4. Wait for visible/pending images to decode so they are painted by the compositor
                        const imgs = Array.from(document.querySelectorAll("img"));
                        const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0).slice(0, 50);
                        if (pending.length > 0) {
                            await Promise.all(pending.map((img) => img.decode().catch(() => {})));
                        }

                        // 5. Wait for web fonts if ready
                        if (document.fonts?.ready) {
                            await document.fonts.ready.catch(() => {});
                        }

                        // 6. Compute exact dimensions in CSS pixels (avoids devicePixelRatio inflation and off-screen voids)
                        const doc = document.documentElement;
                        const body = document.body;
                        const clientWidth = doc.clientWidth || window.innerWidth || 1280;
                        const clientHeight = doc.clientHeight || window.innerHeight || 800;

                        // Only expand width beyond clientWidth if the page is genuinely horizontally scrollable
                        const isHorizontalScrollable =
                            doc.scrollWidth > clientWidth &&
                            window.getComputedStyle(doc).overflowX !== "hidden" &&
                            (!body || window.getComputedStyle(body).overflowX !== "hidden");

                        const width = isHorizontalScrollable
                            ? Math.min(Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, clientWidth), 6000)
                            : clientWidth;

                        const height = Math.min(
                            Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, clientHeight),
                            20000,
                        );

                        return {
                            width: Math.ceil(width),
                            height: Math.ceil(height),
                            clientWidth: Math.ceil(clientWidth),
                            clientHeight: Math.ceil(clientHeight),
                            dpr: window.devicePixelRatio || 1,
                        };
                    })(isFullPage);
                }
            ).toString()})(${isFullPage ? "true" : "false"})`,
            true,
        );

        return res ?? null;
    } catch {
        return null;
    }
}

/** Captures a viewport or full-page screenshot via CDP. */
export async function captureScreenshot(
    target: chrome.debugger.Debuggee,
    opts: { format?: "jpeg" | "png"; quality?: number; fullPage?: boolean },
): Promise<ScreenshotResult | ScreenshotError> {
    await ensureTabActiveForCapture(target);
    const format = opts.format === "png" ? "png" : "jpeg";
    const params: Protocol.Page.CaptureScreenshotRequest = { format };
    if (format === "jpeg") params.quality = opts.quality ?? 80;

    const isFullPage = opts.fullPage === true;
    const pageMetrics = await preparePageForCapture(target, isFullPage);

    if (isFullPage) {
        let width = pageMetrics?.width;
        let height = pageMetrics?.height;

        // Fallback to CDP getLayoutMetrics if page metrics failed
        if (!width || !height) {
            const metrics = await sendCommand(target, "Page.getLayoutMetrics");
            const cssContent = metrics?.cssContentSize;
            const content = metrics?.contentSize;
            const chosen = cssContent ?? content;
            if (chosen) {
                width = chosen.width;
                height = chosen.height;
                // If only deprecated contentSize was present on high-DPI displays, normalize to CSS pixels
                const dpr = pageMetrics?.dpr || 1;
                if (!cssContent && dpr > 1 && width > 1200) {
                    width = Math.round(width / dpr);
                    height = Math.round(height / dpr);
                }
            }
        }

        if (width && height) {
            params.clip = {
                x: 0,
                y: 0,
                width,
                height,
                scale: 1,
            };
            params.captureBeyondViewport = true;
        }
    } else {
        params.captureBeyondViewport = false;
    }

    const res = await sendCommand(target, "Page.captureScreenshot", params, { retryOnTimeout: true });
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
    await ensureTabActiveForCapture(target);
    await preparePageForCapture(target, false);
    await evalOnPage(target, `(${drawAnnotationOverlay.toString()})(${JSON.stringify(boxes)})`);

    const shot = await sendCommand(
        target,
        "Page.captureScreenshot",
        {
            format: "jpeg",
            quality: 80,
            captureBeyondViewport: false,
        },
        { retryOnTimeout: true },
    );

    await evalOnPage(target, `(${removeAnnotationOverlay.toString()})()`);

    if (!shot?.data) {
        return {
            error: "Failed to capture annotated screenshot",
            hint: "The page or debugger session may be in a bad state; try navigating again.",
        };
    }
    return { format: "jpeg", dataBase64: shot.data };
}

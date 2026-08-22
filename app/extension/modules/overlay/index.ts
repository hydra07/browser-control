/** Canvas-rendered visual feedback for browser actions. */
import { evalOnPage, sendCommand } from "../../libs/cdp.js";

type CanvasEffectKind = 0 | 1 | 2 | 3;

type CanvasEffect = {
    kind: CanvasEffectKind;
    start: number;
    duration: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    color: string;
    points: Float32Array | null;
};

type CanvasHudEntry = {
    action: string;
    code: string;
    title: string;
    detail: string;
    start: number;
    duration: number;
};

type CanvasOverlayRuntime = {
    canvas: HTMLCanvasElement;
    moveCursor: (x: number, y: number, duration: number) => void;
    setPressed: (pressed: boolean) => void;
    addClick: (x: number, y: number, color: string, duration: number) => void;
    addKey: (duration: number) => void;
    addScroll: (deltaX: number, deltaY: number, duration: number) => void;
    addDrag: (points: Array<{ x: number; y: number }>, duration: number) => void;
    addHud: (action: string, title: string, detail: string, duration: number) => void;
};

type OverlayWindow = Window & { __bcCanvasOverlay?: CanvasOverlayRuntime };

const canvasInstallations = new Map<number, Promise<boolean>>();
let canvasLifecycleRegistered = false;

export type ActionKind = "click" | "type" | "key" | "scroll" | "drag" | "select" | "search";

export const KIND_COLORS: Record<string, { rgb: { r: number; g: number; b: number }; from: string; to: string }> = {
    click: { rgb: { r: 105, g: 177, b: 238 }, from: "#78bdf4", to: "#397cad" },
    type: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
    key: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
    enter: { rgb: { r: 98, g: 202, b: 154 }, from: "#7ad5aa", to: "#3b946d" },
    scroll: { rgb: { r: 183, g: 162, b: 113 }, from: "#cab785", to: "#927b4c" },
    drag: { rgb: { r: 105, g: 177, b: 238 }, from: "#78bdf4", to: "#397cad" },
    select: { rgb: { r: 128, g: 183, b: 220 }, from: "#8cc6e8", to: "#4e85a8" },
    search: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
};

/** Installs the single demand-driven canvas renderer inside the page. */
export function installCanvasOverlay(): void {
    const overlayWindow = window as OverlayWindow;
    const installed = overlayWindow.__bcCanvasOverlay;
    if (installed?.canvas.isConnected) return;

    document.getElementById("__bc_overlay_canvas__")?.remove();
    const canvas = document.createElement("canvas");
    canvas.id = "__bc_overlay_canvas__";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.setProperty("all", "initial", "important");
    canvas.style.setProperty("position", "fixed", "important");
    canvas.style.setProperty("inset", "0", "important");
    canvas.style.setProperty("width", "100vw", "important");
    canvas.style.setProperty("height", "100vh", "important");
    canvas.style.setProperty("display", "block", "important");
    canvas.style.setProperty("pointer-events", "none", "important");
    canvas.style.setProperty("z-index", "2147483647", "important");
    canvas.style.setProperty("contain", "strict", "important");
    document.documentElement.appendChild(canvas);

    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!context) {
        canvas.remove();
        return;
    }

    const effects: CanvasEffect[] = [];
    const hudEntries: CanvasHudEntry[] = [];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const actionCodes = {
        click: "CLICK",
        type: "TYPE",
        enter: "ENTER",
        key: "KEY",
        scroll: "SCROLL",
        drag: "DRAG",
        search: "FIND",
        select: "SELECT",
        navigate: "GO",
        switch_tab: "TAB",
    } as const;

    let viewportWidth = 0;
    let viewportHeight = 0;
    let pixelRatio = 1;
    let animationFrame = 0;
    let cursorVisible = false;
    let cursorPressed = false;
    let cursorStartX = -100;
    let cursorStartY = -100;
    let cursorX = -100;
    let cursorY = -100;
    let cursorTargetX = -100;
    let cursorTargetY = -100;
    let cursorMoveStart = 0;
    let cursorMoveDuration = 0;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    const easeOut = (value: number) => 1 - (1 - value) ** 3;

    const resize = () => {
        const nextWidth = Math.max(1, window.innerWidth);
        const nextHeight = Math.max(1, window.innerHeight);
        const nextRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        if (nextWidth === viewportWidth && nextHeight === viewportHeight && nextRatio === pixelRatio) return;
        viewportWidth = nextWidth;
        viewportHeight = nextHeight;
        pixelRatio = nextRatio;
        canvas.width = Math.round(nextWidth * nextRatio);
        canvas.height = Math.round(nextHeight * nextRatio);
        context.setTransform(nextRatio, 0, 0, nextRatio, 0, 0);
    };

    const roundedRect = (x: number, y: number, width: number, height: number, radius: number) => {
        context.beginPath();
        context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
    };

    const drawGlass = (x: number, y: number, width: number, height: number, radius: number, opacity: number) => {
        context.save();
        context.globalAlpha = opacity;
        roundedRect(x, y, width, height, radius);
        const fill = context.createLinearGradient(x, y, x + width, y + height);
        fill.addColorStop(0, "rgba(19,30,42,.72)");
        fill.addColorStop(0.48, "rgba(7,13,20,.58)");
        fill.addColorStop(1, "rgba(16,27,38,.68)");
        context.fillStyle = fill;
        context.fill();

        const rim = context.createLinearGradient(x, y, x + width, y + height);
        rim.addColorStop(0, "rgba(244,250,255,.7)");
        rim.addColorStop(0.3, "rgba(188,221,248,.18)");
        rim.addColorStop(0.72, "rgba(83,151,204,.08)");
        rim.addColorStop(1, "rgba(96,181,240,.42)");
        context.strokeStyle = rim;
        context.lineWidth = 1;
        context.stroke();

        roundedRect(x + 1.5, y + 1.5, width - 3, height - 3, Math.max(1, radius - 1.5));
        const sheen = context.createLinearGradient(x, y, x, y + height * 0.6);
        sheen.addColorStop(0, "rgba(255,255,255,.12)");
        sheen.addColorStop(1, "rgba(255,255,255,0)");
        context.strokeStyle = sheen;
        context.stroke();
        context.restore();
    };

    const cursorPosition = (now: number) => {
        if (cursorMoveDuration <= 0) return { x: cursorTargetX, y: cursorTargetY, progress: 1 };
        const progress = clamp01((now - cursorMoveStart) / cursorMoveDuration);
        const eased = easeOut(progress);
        return {
            x: cursorStartX + (cursorTargetX - cursorStartX) * eased,
            y: cursorStartY + (cursorTargetY - cursorStartY) * eased,
            progress,
        };
    };

    const drawCursor = (now: number) => {
        if (!cursorVisible) return false;
        const position = cursorPosition(now);
        cursorX = position.x;
        cursorY = position.y;

        if (position.progress < 1) {
            const trace = context.createLinearGradient(cursorStartX, cursorStartY, cursorX, cursorY);
            trace.addColorStop(0, "rgba(91,164,219,.08)");
            trace.addColorStop(0.72, "rgba(106,183,238,.5)");
            trace.addColorStop(1, "rgba(210,238,255,.82)");
            context.beginPath();
            context.moveTo(cursorStartX, cursorStartY);
            context.lineTo(cursorX, cursorY);
            context.strokeStyle = trace;
            context.lineWidth = 1.25;
            context.stroke();

            context.beginPath();
            context.arc(cursorStartX, cursorStartY, 3 + position.progress * 3, 0, Math.PI * 2);
            context.strokeStyle = `rgba(119,191,242,${0.55 * (1 - position.progress)})`;
            context.lineWidth = 1;
            context.stroke();
        }

        context.save();
        context.translate(cursorX, cursorY);
        context.scale(cursorPressed ? 1.36 : 1, cursorPressed ? 0.7 : 1);
        context.beginPath();
        context.arc(0, 0, 10, 0, Math.PI * 2);
        context.strokeStyle = cursorPressed ? "rgba(220,242,255,.88)" : "rgba(126,196,246,.68)";
        context.lineWidth = 1;
        context.stroke();
        context.beginPath();
        context.arc(0, 0, 4, 0, Math.PI * 2);
        context.fillStyle = cursorPressed ? "#dff3ff" : "#4f9bd3";
        context.fill();
        context.strokeStyle = "rgba(255,255,255,.9)";
        context.lineWidth = 1.25;
        context.stroke();
        context.restore();
        return position.progress < 1;
    };

    const drawClick = (effect: CanvasEffect, progress: number) => {
        const eased = easeOut(progress);
        const radius = 7 + eased * 17;
        const alpha = 1 - progress;
        context.beginPath();
        context.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
        context.strokeStyle = effect.color;
        context.globalAlpha = alpha * 0.9;
        context.lineWidth = 1.5;
        context.stroke();
        context.beginPath();
        context.ellipse(effect.x, effect.y, 5 * (1 - eased * 0.62), 5 * (1 + eased * 0.3), 0, 0, Math.PI * 2);
        context.strokeStyle = "rgba(239,249,255,.86)";
        context.globalAlpha = alpha;
        context.lineWidth = 1;
        context.stroke();
        context.globalAlpha = 1;
    };

    const drawKey = (effect: CanvasEffect, progress: number) => {
        const radiusX = 7 + progress * 18;
        const radiusY = 4 + progress * 7;
        context.save();
        context.globalAlpha = 1 - progress;
        context.beginPath();
        context.ellipse(effect.x, effect.y, radiusX, radiusY, 0, Math.PI * 1.08, Math.PI * 1.92);
        context.strokeStyle = "rgba(116,205,194,.9)";
        context.lineWidth = 1.2;
        context.stroke();
        context.beginPath();
        context.ellipse(effect.x, effect.y, radiusX, radiusY, 0, Math.PI * 0.08, Math.PI * 0.92);
        context.strokeStyle = "rgba(214,245,239,.62)";
        context.stroke();
        context.restore();
    };

    const drawScroll = (effect: CanvasEffect, progress: number) => {
        const length = Math.hypot(effect.dx, effect.dy) || 1;
        const vectorX = (effect.dx / length) * 28;
        const vectorY = (effect.dy / length) * 28;
        const startX = effect.x - vectorX * 0.5 + vectorX * progress;
        const startY = effect.y - vectorY * 0.5 + vectorY * progress;
        const endX = startX + vectorX * 0.55;
        const endY = startY + vectorY * 0.55;
        context.save();
        context.globalAlpha = Math.sin(progress * Math.PI) * 0.9;
        const gradient = context.createLinearGradient(startX, startY, endX, endY);
        gradient.addColorStop(0, "rgba(201,183,137,0)");
        gradient.addColorStop(1, "rgba(224,205,157,.94)");
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.strokeStyle = gradient;
        context.lineWidth = 1.5;
        context.stroke();
        context.beginPath();
        context.arc(endX, endY, 2.25, 0, Math.PI * 2);
        context.fillStyle = "rgba(236,219,175,.92)";
        context.fill();
        context.restore();
    };

    const drawDrag = (effect: CanvasEffect, progress: number) => {
        const points = effect.points;
        if (!points || points.length < 4) return;
        const pointCount = points.length / 2;
        context.save();
        context.beginPath();
        context.moveTo(points[0]!, points[1]!);
        for (let index = 1; index < pointCount; index += 1) {
            context.lineTo(points[index * 2]!, points[index * 2 + 1]!);
        }
        context.setLineDash([3, 5]);
        context.strokeStyle = "rgba(106,179,233,.28)";
        context.lineWidth = 1.25;
        context.stroke();
        context.setLineDash([]);

        const progressIndex = progress * (pointCount - 1);
        const wholeIndex = Math.floor(progressIndex);
        const remainder = progressIndex - wholeIndex;
        context.beginPath();
        context.moveTo(points[0]!, points[1]!);
        for (let index = 1; index <= wholeIndex; index += 1) {
            context.lineTo(points[index * 2]!, points[index * 2 + 1]!);
        }
        if (wholeIndex < pointCount - 1) {
            const fromX = points[wholeIndex * 2]!;
            const fromY = points[wholeIndex * 2 + 1]!;
            const toX = points[(wholeIndex + 1) * 2]!;
            const toY = points[(wholeIndex + 1) * 2 + 1]!;
            context.lineTo(fromX + (toX - fromX) * remainder, fromY + (toY - fromY) * remainder);
        }
        context.strokeStyle = "rgba(116,190,244,.94)";
        context.lineWidth = 2;
        context.stroke();

        const firstX = points[0]!;
        const firstY = points[1]!;
        const lastX = points[points.length - 2]!;
        const lastY = points[points.length - 1]!;
        context.beginPath();
        context.arc(firstX, firstY, 4, 0, Math.PI * 2);
        context.fillStyle = "rgba(8,15,23,.88)";
        context.fill();
        context.strokeStyle = "rgba(190,226,252,.88)";
        context.stroke();
        context.beginPath();
        context.arc(lastX, lastY, 5, 0, Math.PI * 2);
        context.fillStyle = "rgba(112,184,237,.94)";
        context.fill();
        context.stroke();
        context.font = "700 9px ui-monospace, SFMono-Regular, Consolas, monospace";
        context.fillStyle = "rgba(198,226,246,.9)";
        context.fillText("FROM", firstX + 10, firstY - 7);
        context.fillText("TO", lastX + 10, lastY - 7);
        context.restore();
    };

    const drawEffects = (now: number) => {
        let writeIndex = 0;
        for (let index = 0; index < effects.length; index += 1) {
            const effect = effects[index]!;
            const progress = clamp01((now - effect.start) / effect.duration);
            if (effect.kind === 0) drawClick(effect, progress);
            else if (effect.kind === 1) drawKey(effect, progress);
            else if (effect.kind === 2) drawScroll(effect, progress);
            else drawDrag(effect, progress);
            if (progress < 1) effects[writeIndex++] = effect;
        }
        effects.length = writeIndex;
        return writeIndex > 0;
    };

    const drawHudText = (entry: CanvasHudEntry, x: number, y: number, width: number, compact: boolean) => {
        const badgeWidth = compact ? 34 : 42;
        context.fillStyle = entry.action === "scroll" ? "#d7c18e" : entry.action === "enter" ? "#afe2c8" : "#b9daf4";
        context.font = "700 9px ui-monospace, SFMono-Regular, Consolas, monospace";
        context.textBaseline = "middle";
        context.fillText(entry.code, x + 11, y + (compact ? 12 : 23));
        context.save();
        context.beginPath();
        context.rect(x + badgeWidth + 12, y + 4, width - badgeWidth - 20, compact ? 17 : 39);
        context.clip();
        context.fillStyle = "#f2f6f9";
        context.font = `${compact ? "600 10px" : "620 12px"} Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`;
        context.fillText(entry.title, x + badgeWidth + 12, y + (compact ? 12 : 18));
        if (!compact && entry.detail) {
            context.fillStyle = "#8e9baa";
            context.font = "550 9.5px ui-monospace, SFMono-Regular, Consolas, monospace";
            context.fillText(entry.detail, x + badgeWidth + 12, y + 33);
        }
        context.restore();
    };

    const drawHud = (now: number) => {
        let writeIndex = 0;
        for (let index = 0; index < hudEntries.length; index += 1) {
            const entry = hudEntries[index]!;
            if (now - entry.start < entry.duration + 190) hudEntries[writeIndex++] = entry;
        }
        hudEntries.length = writeIndex;
        if (writeIndex === 0) return false;

        const active = hudEntries[0]!;
        const activeAge = now - active.start;
        const enter = easeOut(clamp01(activeAge / 260));
        const exit = clamp01((activeAge - active.duration) / 190);
        const fullWidth = Math.min(370, viewportWidth - 24);
        const activeWidth = 92 + (fullWidth - 92) * enter;
        const activeX = (viewportWidth - activeWidth) / 2;
        const activeOpacity = 1 - exit;
        drawGlass(activeX, 14 - (1 - enter) * 8 - exit * 7, activeWidth, 46, 13, activeOpacity);
        drawHudText(active, activeX, 14 - (1 - enter) * 8 - exit * 7, activeWidth, false);

        const progress = clamp01(activeAge / active.duration);
        context.save();
        context.globalAlpha = activeOpacity * 0.82;
        roundedRect(activeX + 1, 58, (activeWidth - 2) * (1 - progress), 2, 1);
        context.fillStyle = active.action === "scroll" ? "#b99d65" : active.action === "enter" ? "#69bf95" : "#69afe4";
        context.fill();
        context.restore();

        const historyCount = Math.min(2, writeIndex - 1);
        if (historyCount > 0) {
            const gap = 5;
            const chipWidth = Math.min(160, (fullWidth - gap) / historyCount);
            const totalWidth = chipWidth * historyCount + gap * (historyCount - 1);
            const startX = (viewportWidth - totalWidth) / 2;
            for (let index = 0; index < historyCount; index += 1) {
                const entry = hudEntries[index + 1]!;
                const x = startX + index * (chipWidth + gap);
                drawGlass(x, 66, chipWidth, 24, 9, 0.44 - index * 0.1);
                drawHudText(entry, x, 66, chipWidth, true);
            }
        }
        return true;
    };

    const render = (now: number) => {
        animationFrame = 0;
        resize();
        context.clearRect(0, 0, viewportWidth, viewportHeight);
        const effectsActive = drawEffects(now);
        const cursorActive = drawCursor(now);
        const hudActive = drawHud(now);
        if (effectsActive || cursorActive || hudActive) animationFrame = requestAnimationFrame(render);
    };

    const schedule = () => {
        if (animationFrame === 0) animationFrame = requestAnimationFrame(render);
    };

    const addEffect = (
        kind: CanvasEffectKind,
        x: number,
        y: number,
        dx: number,
        dy: number,
        color: string,
        points: Float32Array | null,
        duration: number,
    ) => {
        effects.push({ kind, start: performance.now(), duration, x, y, dx, dy, color, points });
        if (effects.length > 16) effects.splice(0, effects.length - 16);
        schedule();
    };

    const runtime: CanvasOverlayRuntime = {
        canvas,
        moveCursor(x, y, duration) {
            const now = performance.now();
            if (cursorVisible) {
                const position = cursorPosition(now);
                cursorStartX = position.x;
                cursorStartY = position.y;
            } else {
                cursorVisible = true;
                cursorStartX = x;
                cursorStartY = y;
                cursorX = x;
                cursorY = y;
            }
            cursorTargetX = x;
            cursorTargetY = y;
            cursorMoveStart = now;
            cursorMoveDuration = reducedMotion ? 1 : duration;
            schedule();
        },
        setPressed(pressed) {
            cursorPressed = pressed;
            schedule();
        },
        addClick(x, y, color, duration) {
            addEffect(0, x, y, 0, 0, color, null, reducedMotion ? 1 : duration);
        },
        addKey(duration) {
            addEffect(1, cursorX, cursorY, 0, 0, "", null, reducedMotion ? 1 : duration);
        },
        addScroll(deltaX, deltaY, duration) {
            const x = cursorVisible ? cursorX : viewportWidth / 2;
            const y = cursorVisible ? cursorY : viewportHeight / 2;
            addEffect(2, x, y, deltaX, deltaY, "", null, reducedMotion ? 1 : duration);
        },
        addDrag(points, duration) {
            const coordinates = new Float32Array(points.length * 2);
            for (let index = 0; index < points.length; index += 1) {
                const point = points[index]!;
                coordinates[index * 2] = point.x;
                coordinates[index * 2 + 1] = point.y;
            }
            addEffect(3, 0, 0, 0, 0, "", coordinates, reducedMotion ? 1 : duration);
        },
        addHud(action, title, detail, duration) {
            const code = actionCodes[action as keyof typeof actionCodes] ?? action.slice(0, 6).toUpperCase();
            hudEntries.unshift({
                action,
                code,
                title: title.trim().slice(0, 100),
                detail: detail.trim().slice(0, 120),
                start: performance.now(),
                duration: reducedMotion ? 400 : duration,
            });
            if (hudEntries.length > 3) hudEntries.length = 3;
            schedule();
        },
    };

    overlayWindow.__bcCanvasOverlay = runtime;
    window.addEventListener("resize", schedule, { passive: true });
    resize();
    schedule();
}

function registerCanvasLifecycle(): void {
    if (canvasLifecycleRegistered) return;
    canvasLifecycleRegistered = true;
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === "loading") canvasInstallations.delete(tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => canvasInstallations.delete(tabId));
}

async function ensureCanvasOverlay(target: chrome.debugger.Debuggee): Promise<boolean> {
    registerCanvasLifecycle();
    const tabId = target.tabId;
    if (tabId === undefined) {
        await evalOnPage(target, `(${installCanvasOverlay.toString()})()`, true);
        return true;
    }

    const activeInstallation = canvasInstallations.get(tabId);
    if (activeInstallation) return activeInstallation;

    const installation = (async () => {
        try {
            const result = await sendCommand(target, "Runtime.evaluate", {
                expression: `(${installCanvasOverlay.toString()})()`,
                awaitPromise: true,
            });
            if (result?.exceptionDetails) {
                console.error(
                    "[browsercontrol] canvas overlay installation failed:",
                    result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
                );
                return false;
            }
            return true;
        } catch (error) {
            console.error("[browsercontrol] canvas overlay installation failed:", String(error));
            return false;
        }
    })();
    canvasInstallations.set(tabId, installation);
    if (!(await installation)) canvasInstallations.delete(tabId);
    return installation;
}

/** Runs a small canvas command after installing the renderer once per document. */
export async function runCanvasOverlay(
    target: chrome.debugger.Debuggee,
    invocation: string,
    awaitPromise = false,
): Promise<void> {
    if (!(await ensureCanvasOverlay(target))) return;
    await evalOnPage(target, invocation, awaitPromise);
}

/** Moves the shared canvas cursor and preserves a precise source-to-target trace. */
export function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
    const runtime = (window as OverlayWindow).__bcCanvasOverlay;
    const duration = fast ? 180 : 520;
    runtime?.moveCursor(x, y, duration);
    return new Promise((resolve) => setTimeout(resolve, duration + 20));
}

/** Squashes the shared canvas cursor in sync with the real pointer state. */
export function pulseCursorPress(pressed: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.setPressed(pressed);
}

/** Adds a lens-compression ripple to the shared canvas. */
export function showClickRipple(x: number, y: number, kind: "click" | "type" = "click", fast?: boolean): void {
    const color = kind === "type" ? "rgba(111,199,190,.92)" : "rgba(111,183,239,.92)";
    (window as OverlayWindow).__bcCanvasOverlay?.addClick(x, y, color, fast ? 260 : 430);
}

/** Adds keyboard motion at the current canvas cursor position. */
export function showKeyMotion(fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addKey(fast ? 190 : 320);
}

/** Adds a directional scroll vector to the shared canvas. */
export function showScrollMotion(deltaX: number, deltaY: number, fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addScroll(deltaX, deltaY, fast ? 220 : 390);
}

/** Highlights a browser target outside the page's stacking contexts. */
export async function showNativeHighlight(
    target: chrome.debugger.Debuggee,
    box: { x: number; y: number; w: number; h: number },
    rgb: { r: number; g: number; b: number },
): Promise<void> {
    await sendCommand(target, "Overlay.highlightRect", {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.w),
        height: Math.round(box.h),
        color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.12 },
        outlineColor: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.86 },
    });
}

export function hideNativeHighlight(target: chrome.debugger.Debuggee): void {
    void sendCommand(target, "Overlay.hideHighlight").catch(() => {});
}

/** Delays through a CDP round trip so service-worker suspension cannot interrupt it. */
export function pageDelay(target: chrome.debugger.Debuggee, ms: number): Promise<void> {
    return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

/** Adds an action to the single canvas-rendered browser-control rail. */
export function showActionHud(action: string, title: string, detail?: string, fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addHud(action, title, detail ?? "", fast ? 900 : 1800);
}

/** Adds drag origin, destination, and progress to the shared canvas. */
export function showDragTrajectory(points: Array<{ x: number; y: number }>, fast?: boolean): void {
    if (points.length < 2) return;
    (window as OverlayWindow).__bcCanvasOverlay?.addDrag(points, fast ? 1_000 : 1_750);
}

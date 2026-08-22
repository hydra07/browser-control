/** Single-canvas visual feedback for browser actions. */
import { evalOnPage, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";

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
    version: number;
    canvas: HTMLCanvasElement;
    destroy: () => void;
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
const CANVAS_OVERLAY_VERSION = 2;

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

/** Installs the demand-driven liquid canvas renderer inside the page. */
export function installCanvasOverlay(version: number): void {
    const overlayWindow = window as OverlayWindow;
    const installed = overlayWindow.__bcCanvasOverlay;
    if (
        installed?.version === version &&
        installed.canvas.isConnected &&
        typeof installed.addHud === "function" &&
        typeof installed.moveCursor === "function"
    ) {
        return;
    }

    installed?.destroy?.();
    overlayWindow.__bcCanvasOverlay = undefined;

    document.getElementById("__bc_overlay_canvas__")?.remove();
    document.getElementById("__bc_activity_hud__")?.remove();
    document.getElementById("__bc_hud_style__")?.remove();

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
    let previousFrameTime = performance.now();
    let cursorVisible = false;
    let cursorPressed = false;
    let cursorPressAmount = 0;
    let cursorStartX = -100;
    let cursorStartY = -100;
    let cursorStartVelocityX = 0;
    let cursorStartVelocityY = 0;
    let cursorX = -100;
    let cursorY = -100;
    let cursorTargetX = -100;
    let cursorTargetY = -100;
    let cursorMoveStart = 0;
    let cursorMoveDuration = 0;

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    const smootherStep = (value: number) => value * value * value * (value * (value * 6 - 15) + 10);
    const liquidEnter = (value: number) => {
        const offset = value - 1;
        return 1 + 1.35 * offset ** 3 + 0.35 * offset ** 2;
    };

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

    const drawLiquidMembrane = (
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number,
        opacity: number,
    ) => {
        context.save();
        context.globalAlpha = opacity;
        roundedRect(x, y, width, height, radius);
        const membrane = context.createLinearGradient(x, y, x + width, y + height);
        membrane.addColorStop(0, "rgba(222,241,255,.17)");
        membrane.addColorStop(0.22, "rgba(112,181,229,.075)");
        membrane.addColorStop(0.52, "rgba(8,20,31,.15)");
        membrane.addColorStop(0.8, "rgba(69,137,190,.07)");
        membrane.addColorStop(1, "rgba(205,235,255,.12)");
        context.fillStyle = membrane;
        context.fill();

        context.globalCompositeOperation = "screen";
        context.save();
        context.translate(-0.7, 0);
        roundedRect(x, y, width, height, radius);
        context.strokeStyle = "rgba(255,105,145,.1)";
        context.lineWidth = 1;
        context.stroke();
        context.restore();
        context.save();
        context.translate(0.7, 0);
        roundedRect(x, y, width, height, radius);
        context.strokeStyle = "rgba(77,190,255,.2)";
        context.lineWidth = 1;
        context.stroke();
        context.restore();

        roundedRect(x + 0.5, y + 0.5, width - 1, height - 1, radius - 0.5);
        const rim = context.createLinearGradient(x, y, x + width, y + height);
        rim.addColorStop(0, "rgba(255,255,255,.78)");
        rim.addColorStop(0.2, "rgba(225,243,255,.28)");
        rim.addColorStop(0.5, "rgba(255,255,255,.045)");
        rim.addColorStop(0.78, "rgba(80,174,236,.12)");
        rim.addColorStop(1, "rgba(187,231,255,.5)");
        context.strokeStyle = rim;
        context.lineWidth = 1;
        context.stroke();

        roundedRect(x + 2, y + 2, width - 4, Math.max(1, height * 0.52), Math.max(1, radius - 2));
        const caustic = context.createLinearGradient(x, y, x + width * 0.78, y + height * 0.42);
        caustic.addColorStop(0, "rgba(255,255,255,.2)");
        caustic.addColorStop(0.32, "rgba(255,255,255,.035)");
        caustic.addColorStop(1, "rgba(255,255,255,0)");
        context.strokeStyle = caustic;
        context.lineWidth = 0.8;
        context.stroke();
        context.restore();
    };

    const cursorPosition = (now: number) => {
        if (cursorMoveDuration <= 0) {
            return { x: cursorTargetX, y: cursorTargetY, velocityX: 0, velocityY: 0, progress: 1 };
        }
        const progress = clamp01((now - cursorMoveStart) / cursorMoveDuration);
        const progress2 = progress * progress;
        const progress3 = progress2 * progress;
        const h00 = 2 * progress3 - 3 * progress2 + 1;
        const h10 = progress3 - 2 * progress2 + progress;
        const h01 = -2 * progress3 + 3 * progress2;
        const tangentX = cursorStartVelocityX * cursorMoveDuration;
        const tangentY = cursorStartVelocityY * cursorMoveDuration;
        const derivativeH00 = 6 * progress2 - 6 * progress;
        const derivativeH10 = 3 * progress2 - 4 * progress + 1;
        const derivativeH01 = -derivativeH00;
        return {
            x: h00 * cursorStartX + h10 * tangentX + h01 * cursorTargetX,
            y: h00 * cursorStartY + h10 * tangentY + h01 * cursorTargetY,
            velocityX:
                (derivativeH00 * cursorStartX + derivativeH10 * tangentX + derivativeH01 * cursorTargetX) /
                cursorMoveDuration,
            velocityY:
                (derivativeH00 * cursorStartY + derivativeH10 * tangentY + derivativeH01 * cursorTargetY) /
                cursorMoveDuration,
            progress,
        };
    };

    const drawCursor = (now: number, frameDelta: number) => {
        if (!cursorVisible) return false;
        const position = cursorPosition(now);
        cursorX = position.x;
        cursorY = position.y;
        const pressTarget = cursorPressed ? 1 : 0;
        const pressBlend = 1 - Math.exp(-frameDelta * 0.026);
        cursorPressAmount += (pressTarget - cursorPressAmount) * pressBlend;

        if (position.progress < 1) {
            const distance = Math.hypot(cursorX - cursorStartX, cursorY - cursorStartY);
            const bend = Math.min(18, distance * 0.08);
            const directionX = distance > 0 ? (cursorX - cursorStartX) / distance : 0;
            const directionY = distance > 0 ? (cursorY - cursorStartY) / distance : 0;
            const controlX = (cursorStartX + cursorX) * 0.5 - directionY * bend;
            const controlY = (cursorStartY + cursorY) * 0.5 + directionX * bend;
            const trace = context.createLinearGradient(cursorStartX, cursorStartY, cursorX, cursorY);
            trace.addColorStop(0, "rgba(128,205,255,.035)");
            trace.addColorStop(0.7, "rgba(102,188,246,.38)");
            trace.addColorStop(1, "rgba(228,247,255,.82)");
            context.beginPath();
            context.moveTo(cursorStartX, cursorStartY);
            context.quadraticCurveTo(controlX, controlY, cursorX, cursorY);
            context.strokeStyle = trace;
            context.lineWidth = 1.2;
            context.stroke();

            context.beginPath();
            context.arc(cursorStartX, cursorStartY, 2.5 + smootherStep(position.progress) * 3.5, 0, Math.PI * 2);
            context.strokeStyle = `rgba(150,214,255,${0.5 * (1 - position.progress) ** 2})`;
            context.lineWidth = 1;
            context.stroke();
        }

        const scaleX = 1 + cursorPressAmount * 0.34;
        const scaleY = 1 - cursorPressAmount * 0.3;
        context.save();
        context.translate(cursorX, cursorY);
        context.scale(scaleX, scaleY);
        const lens = context.createRadialGradient(-3, -4, 0, 0, 0, 11);
        lens.addColorStop(0, "rgba(255,255,255,.2)");
        lens.addColorStop(0.5, "rgba(120,200,250,.05)");
        lens.addColorStop(1, "rgba(80,170,235,0)");
        context.beginPath();
        context.arc(0, 0, 10.5, 0, Math.PI * 2);
        context.fillStyle = lens;
        context.fill();
        context.globalCompositeOperation = "screen";
        context.beginPath();
        context.arc(-0.55, 0, 9.7, 0, Math.PI * 2);
        context.strokeStyle = "rgba(255,112,151,.13)";
        context.lineWidth = 0.8;
        context.stroke();
        context.beginPath();
        context.arc(0.55, 0, 9.7, 0, Math.PI * 2);
        context.strokeStyle = "rgba(83,191,255,.34)";
        context.stroke();
        context.beginPath();
        context.arc(0, 0, 3.4, 0, Math.PI * 2);
        context.fillStyle = cursorPressAmount > 0.5 ? "rgba(225,246,255,.96)" : "rgba(92,179,236,.9)";
        context.fill();
        context.strokeStyle = "rgba(255,255,255,.86)";
        context.lineWidth = 1;
        context.stroke();
        context.restore();

        return position.progress < 1 || Math.abs(pressTarget - cursorPressAmount) > 0.005;
    };

    const drawClick = (effect: CanvasEffect, progress: number) => {
        const eased = smootherStep(progress);
        const radius = 6 + eased * 22;
        const alpha = (1 - progress) ** 2;
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(effect.x - 0.8, effect.y, radius, 0, Math.PI * 2);
        context.strokeStyle = "rgba(255,110,151,.28)";
        context.lineWidth = 1;
        context.stroke();
        context.beginPath();
        context.arc(effect.x + 0.8, effect.y, radius, 0, Math.PI * 2);
        context.strokeStyle = effect.color;
        context.lineWidth = 1.35;
        context.stroke();
        context.beginPath();
        context.ellipse(effect.x, effect.y, 5.5 * (1 - eased * 0.58), 5.5 * (1 + eased * 0.26), 0, 0, Math.PI * 2);
        context.strokeStyle = "rgba(242,251,255,.78)";
        context.lineWidth = 0.9;
        context.stroke();
        context.restore();
    };

    const drawKey = (effect: CanvasEffect, progress: number) => {
        const eased = smootherStep(progress);
        const alpha = (1 - progress) ** 2;
        context.save();
        context.globalCompositeOperation = "screen";
        context.globalAlpha = alpha;
        for (let wave = 0; wave < 2; wave += 1) {
            const phase = clamp01(eased - wave * 0.14);
            context.beginPath();
            context.ellipse(effect.x, effect.y, 7 + phase * 22, 3.5 + phase * 8, 0, 0, Math.PI * 2);
            context.strokeStyle = wave === 0 ? "rgba(123,220,207,.78)" : "rgba(215,250,244,.4)";
            context.lineWidth = wave === 0 ? 1.15 : 0.8;
            context.stroke();
        }
        context.restore();
    };

    const drawScroll = (effect: CanvasEffect, progress: number) => {
        const length = Math.hypot(effect.dx, effect.dy) || 1;
        const vectorX = (effect.dx / length) * 36;
        const vectorY = (effect.dy / length) * 36;
        context.save();
        context.globalCompositeOperation = "screen";
        for (let particle = 0; particle < 3; particle += 1) {
            const phase = clamp01(progress * 1.28 - particle * 0.14);
            const eased = smootherStep(phase);
            const x = effect.x - vectorX * 0.5 + vectorX * eased;
            const y = effect.y - vectorY * 0.5 + vectorY * eased;
            context.globalAlpha = Math.sin(phase * Math.PI) * (0.78 - particle * 0.16);
            context.beginPath();
            context.arc(x, y, 2.3 - particle * 0.35, 0, Math.PI * 2);
            context.fillStyle = particle === 0 ? "rgba(235,218,175,.9)" : "rgba(127,205,247,.6)";
            context.fill();
        }
        context.restore();
    };

    const drawDrag = (effect: CanvasEffect, progress: number) => {
        const points = effect.points;
        if (!points || points.length < 4) return;
        const pointCount = points.length / 2;
        const eased = smootherStep(progress);
        context.save();
        context.beginPath();
        context.moveTo(points[0]!, points[1]!);
        for (let index = 1; index < pointCount; index += 1) context.lineTo(points[index * 2]!, points[index * 2 + 1]!);
        context.setLineDash([2, 6]);
        context.strokeStyle = "rgba(119,194,244,.2)";
        context.lineWidth = 1;
        context.stroke();
        context.setLineDash([]);

        const progressIndex = eased * (pointCount - 1);
        const wholeIndex = Math.floor(progressIndex);
        const remainder = progressIndex - wholeIndex;
        let headX = points[0]!;
        let headY = points[1]!;
        context.beginPath();
        context.moveTo(headX, headY);
        for (let index = 1; index <= wholeIndex; index += 1) {
            headX = points[index * 2]!;
            headY = points[index * 2 + 1]!;
            context.lineTo(headX, headY);
        }
        if (wholeIndex < pointCount - 1) {
            const toX = points[(wholeIndex + 1) * 2]!;
            const toY = points[(wholeIndex + 1) * 2 + 1]!;
            headX += (toX - headX) * remainder;
            headY += (toY - headY) * remainder;
            context.lineTo(headX, headY);
        }
        const progressGradient = context.createLinearGradient(points[0]!, points[1]!, headX, headY);
        progressGradient.addColorStop(0, "rgba(107,188,242,.18)");
        progressGradient.addColorStop(1, "rgba(197,235,255,.92)");
        context.strokeStyle = progressGradient;
        context.lineWidth = 1.8;
        context.stroke();
        context.globalCompositeOperation = "screen";
        context.beginPath();
        context.arc(headX, headY, 3.2, 0, Math.PI * 2);
        context.fillStyle = "rgba(218,242,255,.9)";
        context.fill();

        const firstX = points[0]!;
        const firstY = points[1]!;
        const lastX = points[points.length - 2]!;
        const lastY = points[points.length - 1]!;
        context.beginPath();
        context.arc(firstX, firstY, 4, 0, Math.PI * 2);
        context.strokeStyle = "rgba(190,226,252,.7)";
        context.lineWidth = 1;
        context.stroke();
        context.beginPath();
        context.arc(lastX, lastY, 5, 0, Math.PI * 2);
        context.strokeStyle = "rgba(115,199,250,.78)";
        context.stroke();
        context.font = "700 9px ui-monospace, SFMono-Regular, Consolas, monospace";
        context.fillStyle = "rgba(202,231,249,.78)";
        context.fillText("FROM", firstX + 9, firstY - 7);
        context.fillText("TO", lastX + 9, lastY - 7);
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

    const drawReadableText = (text: string, x: number, y: number, color: string) => {
        context.lineJoin = "round";
        context.strokeStyle = "rgba(2,8,14,.72)";
        context.lineWidth = 2.6;
        context.strokeText(text, x, y);
        context.fillStyle = color;
        context.fillText(text, x, y);
    };

    const drawHud = (now: number) => {
        let writeIndex = 0;
        for (let index = 0; index < hudEntries.length; index += 1) {
            const entry = hudEntries[index]!;
            if (now - entry.start < entry.duration + 240) hudEntries[writeIndex++] = entry;
        }
        hudEntries.length = writeIndex;
        if (writeIndex === 0) return false;

        const active = hudEntries[0]!;
        const activeAge = now - active.start;
        const enterProgress = clamp01(activeAge / 300);
        const enter = liquidEnter(enterProgress);
        const exit = smootherStep(clamp01((activeAge - active.duration) / 240));
        const historyCount = Math.min(2, writeIndex - 1);
        const historyReveal = smootherStep(clamp01((activeAge - 110) / 260));
        const fullWidth = Math.min(344, Math.max(80, viewportWidth - 24));
        const compactWidth = Math.min(248, fullWidth);
        const width = compactWidth + (fullWidth - compactWidth) * enter;
        const height = 50 + historyCount * 18 * historyReveal;
        const right = 16 - (1 - enterProgress) * 18 + exit * 22;
        const bottom = 16 - (1 - enterProgress) * 10 + exit * 8;
        const x = viewportWidth - width - right;
        const y = viewportHeight - height - bottom;
        const opacity = (1 - exit) * clamp01(enterProgress * 1.8);
        drawLiquidMembrane(x, y, width, height, 16, opacity);

        context.save();
        context.globalAlpha = opacity;
        context.textBaseline = "middle";
        context.font = "720 9px ui-monospace, SFMono-Regular, Consolas, monospace";
        const actionColor = active.action === "scroll" ? "#ead6a4" : active.action === "enter" ? "#b6ebd0" : "#cceaff";
        context.beginPath();
        context.arc(x + 15, y + 17, 2.5, 0, Math.PI * 2);
        context.fillStyle = actionColor;
        context.fill();
        drawReadableText(active.code, x + 23, y + 17, actionColor);

        context.save();
        context.beginPath();
        context.rect(x + 70, y + 5, width - 80, 39);
        context.clip();
        context.font = "630 12px Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
        drawReadableText(active.title, x + 70, y + 16, "rgba(249,252,255,.96)");
        if (active.detail) {
            context.font = "560 9.5px ui-monospace, SFMono-Regular, Consolas, monospace";
            drawReadableText(active.detail, x + 70, y + 33, "rgba(202,220,234,.78)");
        }
        context.restore();

        const actionProgress = clamp01(activeAge / active.duration);
        const progressWidth = Math.max(0, (width - 16) * (1 - actionProgress));
        if (progressWidth > 0) {
            const progressGradient = context.createLinearGradient(x + 8, y, x + width - 8, y);
            progressGradient.addColorStop(0, "rgba(255,255,255,.12)");
            progressGradient.addColorStop(0.55, "rgba(111,199,249,.72)");
            progressGradient.addColorStop(1, "rgba(255,142,176,.16)");
            roundedRect(x + 8, y + 46, progressWidth, 1.5, 0.75);
            context.fillStyle = progressGradient;
            context.fill();
        }

        for (let index = 0; index < historyCount; index += 1) {
            const entry = hudEntries[index + 1]!;
            const rowY = y + 54 + index * 18;
            context.globalAlpha = opacity * historyReveal * (0.48 - index * 0.12);
            context.beginPath();
            context.arc(x + 15, rowY + 5, 1.7, 0, Math.PI * 2);
            context.fillStyle = "rgba(181,222,248,.75)";
            context.fill();
            context.font = "690 8px ui-monospace, SFMono-Regular, Consolas, monospace";
            drawReadableText(entry.code, x + 22, rowY + 5, "rgba(199,229,248,.76)");
            context.save();
            context.beginPath();
            context.rect(x + 63, rowY - 3, width - 72, 16);
            context.clip();
            context.font = "560 9.5px Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
            drawReadableText(entry.title, x + 63, rowY + 5, "rgba(222,237,247,.7)");
            context.restore();
        }
        context.restore();
        return true;
    };

    const render = (now: number) => {
        animationFrame = 0;
        resize();
        const frameDelta = Math.min(48, Math.max(1, now - previousFrameTime));
        previousFrameTime = now;
        context.clearRect(0, 0, viewportWidth, viewportHeight);
        const effectsActive = drawEffects(now);
        const cursorActive = drawCursor(now, frameDelta);
        const hudActive = drawHud(now);
        if (effectsActive || cursorActive || hudActive) animationFrame = requestAnimationFrame(render);
    };

    const schedule = () => {
        if (animationFrame !== 0) return;
        previousFrameTime = performance.now();
        animationFrame = requestAnimationFrame(render);
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
        version,
        canvas,
        destroy() {
            if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
            animationFrame = 0;
            effects.length = 0;
            hudEntries.length = 0;
            window.removeEventListener("resize", schedule);
            canvas.remove();
            if (overlayWindow.__bcCanvasOverlay === runtime) overlayWindow.__bcCanvasOverlay = undefined;
        },
        moveCursor(x, y, duration) {
            const now = performance.now();
            if (cursorVisible) {
                const position = cursorPosition(now);
                cursorStartX = position.x;
                cursorStartY = position.y;
                const tangentLength = Math.hypot(position.velocityX * duration, position.velocityY * duration);
                const maxTangent = Math.hypot(x - position.x, y - position.y) * 1.35 + 32;
                const velocityScale = tangentLength > maxTangent ? maxTangent / tangentLength : 1;
                cursorStartVelocityX = position.velocityX * velocityScale;
                cursorStartVelocityY = position.velocityY * velocityScale;
            } else {
                cursorVisible = true;
                cursorStartX = x;
                cursorStartY = y;
                cursorStartVelocityX = 0;
                cursorStartVelocityY = 0;
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
                duration: reducedMotion ? 450 : duration,
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
        await evalOnPage(target, `(${installCanvasOverlay.toString()})(${CANVAS_OVERLAY_VERSION})`, true);
        return true;
    }

    const activeInstallation = canvasInstallations.get(tabId);
    if (activeInstallation) return activeInstallation;

    const installation = (async () => {
        try {
            const result = await sendCommand(target, "Runtime.evaluate", {
                expression: `(${installCanvasOverlay.toString()})(${CANVAS_OVERLAY_VERSION})`,
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

async function evaluateCanvasInvocation(
    target: chrome.debugger.Debuggee,
    invocation: string,
    awaitPromise: boolean,
): Promise<boolean> {
    const guardedInvocation = awaitPromise
        ? `(async()=>{const r=window.__bcCanvasOverlay;if(r?.version!==${CANVAS_OVERLAY_VERSION}||!r.canvas?.isConnected)return false;await (${invocation});return true})()`
        : `(()=>{const r=window.__bcCanvasOverlay;if(r?.version!==${CANVAS_OVERLAY_VERSION}||!r.canvas?.isConnected)return false;${invocation};return true})()`;
    try {
        const result = await sendCommand(target, "Runtime.evaluate", {
            expression: guardedInvocation,
            awaitPromise,
            returnByValue: true,
        });
        if (result?.exceptionDetails) {
            console.error(
                "[browsercontrol] visual feedback script threw:",
                result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
            );
            return true;
        }
        return result.result.value === true;
    } catch (error) {
        const message = errorMessage(error);
        if (
            message.includes("Debugger is not attached") ||
            message.includes("No tab with id") ||
            message.includes("Target closed") ||
            message.includes("Session with given id not found")
        ) {
            return true;
        }
        console.error("[browsercontrol] visual feedback command failed:", message);
        return true;
    }
}

/** Runs a small canvas command after installing the renderer once per document. */
export async function runCanvasOverlay(
    target: chrome.debugger.Debuggee,
    invocation: string,
    awaitPromise = false,
): Promise<void> {
    if (!(await ensureCanvasOverlay(target))) return;
    if (await evaluateCanvasInvocation(target, invocation, awaitPromise)) return;

    if (target.tabId !== undefined) canvasInstallations.delete(target.tabId);
    if (!(await ensureCanvasOverlay(target))) return;
    await evaluateCanvasInvocation(target, invocation, awaitPromise);
}

/** Moves the shared canvas cursor with velocity continuity. */
export function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
    const runtime = (window as OverlayWindow).__bcCanvasOverlay;
    const duration = fast ? 190 : 560;
    runtime?.moveCursor(x, y, duration);
    return new Promise((resolve) => setTimeout(resolve, duration + 20));
}

/** Squashes the shared canvas cursor in sync with the real pointer state. */
export function pulseCursorPress(pressed: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.setPressed(pressed);
}

/** Adds a chromatic liquid ripple to the shared canvas. */
export function showClickRipple(x: number, y: number, kind: "click" | "type" = "click", fast?: boolean): void {
    const color = kind === "type" ? "rgba(111,213,198,.76)" : "rgba(94,190,250,.8)";
    (window as OverlayWindow).__bcCanvasOverlay?.addClick(x, y, color, fast ? 290 : 480);
}

/** Adds keyboard membrane waves at the current cursor position. */
export function showKeyMotion(fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addKey(fast ? 240 : 420);
}

/** Adds smooth directional scroll particles to the shared canvas. */
export function showScrollMotion(deltaX: number, deltaY: number, fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addScroll(deltaX, deltaY, fast ? 300 : 520);
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
        color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.1 },
        outlineColor: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.78 },
    });
}

export function hideNativeHighlight(target: chrome.debugger.Debuggee): void {
    void sendCommand(target, "Overlay.hideHighlight").catch(() => {});
}

/** Delays through a CDP round trip so service-worker suspension cannot interrupt it. */
export function pageDelay(target: chrome.debugger.Debuggee, ms: number): Promise<void> {
    return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

/** Adds an action to the unified liquid canvas rail. */
export function showActionHud(action: string, title: string, detail?: string, fast?: boolean): void {
    (window as OverlayWindow).__bcCanvasOverlay?.addHud(action, title, detail ?? "", fast ? 1_000 : 1_900);
}

/** Adds drag origin, destination, and progress to the shared canvas. */
export function showDragTrajectory(points: Array<{ x: number; y: number }>, fast?: boolean): void {
    if (points.length < 2) return;
    (window as OverlayWindow).__bcCanvasOverlay?.addDrag(points, fast ? 1_100 : 1_900);
}

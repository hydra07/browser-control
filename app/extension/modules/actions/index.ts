/**
 * Core user input actions (click, type, press_key, scroll, drag) via CDP Input events,
 * paired with cursor movement, ripple effects, and visual overlays.
 */

import type { Point } from "@browsercontrol/shared";
import { quadToBox, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import {
    hideNativeHighlight,
    KIND_COLORS,
    moveCursorTo,
    pulseCursorPress,
    runCanvasOverlay,
    showActionHud,
    showClickRipple,
    showDragTrajectory,
    showKeyMotion,
    showNativeHighlight,
    showScrollMotion,
} from "../overlay/index.js";
import { waitForStableDom } from "../wait/index.js";
import { KEY_DEFS, RISKY_NAME_PATTERN, SINGLE_CHAR_SYMBOL_CODES, SUPPORTED_KEYS } from "./constants.js";
import type { ActionResult, AxInfo, DragOptions } from "./types.js";

export type { ActionResult, AxInfo, DragOptions } from "./types.js";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyHudAction(kind: "click" | "type", axInfo: AxInfo): string {
    const target = `${axInfo.role ?? ""} ${axInfo.name ?? ""}`.toLowerCase();
    if (target.includes("search")) return "search";
    if (target.includes("combobox") || target.includes("listbox") || target.includes("select")) return "select";
    return kind;
}

function showHud(target: chrome.debugger.Debuggee, action: string, title: string, detail: string, fast: boolean): void {
    void runCanvasOverlay(
        target,
        `(${showActionHud.toString()})(${JSON.stringify(action)},${JSON.stringify(title)},${JSON.stringify(detail)},${fast})`,
        true,
    );
}

export async function getAxInfoForNode(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<AxInfo> {
    try {
        const result = await sendCommand(target, "Accessibility.queryAXTree", {
            backendNodeId,
        });
        const node = result?.nodes?.[0];
        return { role: node?.role?.value, name: node?.name?.value };
    } catch {
        return {};
    }
}

/**
 * Reads back an input/textarea's `.value` (or a contenteditable's
 * `.textContent`) straight from the page. `Input.insertText` isn't targeted
 * at a node — it inserts wherever focus currently sits — so a framework's
 * own re-render or competing autofocus between our `DOM.focus` call and the
 * insert can silently swallow the keystrokes. Returns null if the node is
 * gone (detached/re-rendered) or unreadable.
 */
async function readElementText(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<string | null> {
    try {
        const resolved = await sendCommand(target, "DOM.resolveNode", { backendNodeId });
        const objectId = resolved?.object?.objectId;
        if (!objectId) return null;
        const result = await sendCommand(target, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration:
                "function () { return this.value || this.textContent || this.parentElement?.innerText || this.closest('.oo-ui-widget, .tag-input, .multiselect, .chips, .tokenfield, form')?.innerText || ''; }",
            returnByValue: true,
        });
        return typeof result?.result?.value === "string" ? result.result.value : null;
    } catch {
        return null;
    }
}

/** Scroll target element into view, retrying once if layout object is not yet attached. */
async function scrollIntoViewWithRetry(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<void> {
    try {
        await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId,
        });
    } catch (e) {
        if (!errorMessage(e).includes("does not have a layout object")) {
            throw e;
        }
        await sleep(200);
        try {
            await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
                backendNodeId,
            });
        } catch {
            // Virtual accessibility node, SVG path, or canvas child with no CSS box
        }
    }
}

export function isRiskyTarget(axInfo: AxInfo): boolean {
    return !!axInfo.name && RISKY_NAME_PATTERN.test(axInfo.name);
}

export function withRiskWarning(result: ActionResult, axInfo: AxInfo, verb: string): ActionResult {
    if ("success" in result && isRiskyTarget(axInfo)) {
        result._riskWarning = `This ${verb} ${axInfo.role ?? "element"} "${axInfo.name}", which looks potentially destructive/irreversible.`;
    }
    return result;
}

async function getBoxModelWithRetry(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
): Promise<{ model?: { content: number[] } } | null> {
    try {
        return await sendCommand(target, "DOM.getBoxModel", { backendNodeId });
    } catch {
        await sleep(150);
        return await sendCommand(target, "DOM.getBoxModel", { backendNodeId }).catch(() => null);
    }
}

export async function resolveNodeBounds(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
    const boxModel = await getBoxModelWithRetry(target, backendNodeId);
    if (boxModel?.model?.content) {
        const box = quadToBox(
            boxModel.model.content as [number, number, number, number, number, number, number, number],
        );
        if (box.w > 0 || box.h > 0) return box;
    }
    try {
        const quads = await sendCommand(target, "DOM.getContentQuads", { backendNodeId });
        if (quads?.quads?.[0]) {
            const box = quadToBox(quads.quads[0] as [number, number, number, number, number, number, number, number]);
            if (box.w > 0 || box.h > 0) return box;
        }
    } catch {}
    try {
        const resolved = await sendCommand(target, "DOM.resolveNode", { backendNodeId });
        const objectId = resolved?.object?.objectId;
        if (objectId) {
            const rectResult = await sendCommand(target, "Runtime.callFunctionOn", {
                objectId,
                functionDeclaration:
                    "function () { const r = this.getBoundingClientRect ? this.getBoundingClientRect() : null; return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; }",
                returnByValue: true,
            });
            const r = rectResult?.result?.value;
            if (r && (r.w > 0 || r.h > 0 || r.x > 0 || r.y > 0)) return r;
        }
    } catch {}
    return null;
}

/** Performs a left click with cursor glide, ripple, and risk inspection. */
export async function performClick(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    await scrollIntoViewWithRetry(target, backendNodeId);
    const box = await resolveNodeBounds(target, backendNodeId);
    if (!box) {
        return {
            error: "Failed to resolve node bounds",
            hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry.",
        };
    }
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;

    const [, axInfo] = await Promise.all([
        runCanvasOverlay(target, `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`, true),
        getAxInfoForNode(target, backendNodeId),
    ]);
    const targetLabel = axInfo.name ?? axInfo.role ?? "Page element";
    showHud(target, classifyHudAction("click", axInfo), targetLabel, `Clicking ${axInfo.role ?? "element"}`, opts.fast);
    await showNativeHighlight(target, box, KIND_COLORS.click.rgb);
    if (!opts.fast) await sleep(350);

    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(true)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    void runCanvasOverlay(target, `(${showClickRipple.toString()})(${x}, ${y}, 'click', ${opts.fast})`);
    if (!opts.fast) await sleep(130);
    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(false)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    await waitForStableDom(target);
    setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);

    return withRiskWarning(
        {
            success: true,
            message: `Clicked at (${x}, ${y})`,
            role: axInfo.role,
            name: axInfo.name,
        },
        axInfo,
        "clicked",
    );
}

/** Performs a left click at direct viewport coordinates. */
export async function performClickAt(
    target: chrome.debugger.Debuggee,
    x: number,
    y: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    await runCanvasOverlay(target, `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`, true);
    showHud(target, "click", "Canvas point", `Clicking at (${Math.round(x)}, ${Math.round(y)})`, opts.fast);
    if (!opts.fast) await sleep(200);

    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(true)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    void runCanvasOverlay(target, `(${showClickRipple.toString()})(${x}, ${y}, 'click', ${opts.fast})`);
    if (!opts.fast) await sleep(130);
    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(false)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    await waitForStableDom(target);

    return {
        success: true,
        message: `Clicked at (${x}, ${y})`,
    };
}

/** Types text into a targeted element (or currently focused input) with cursor glide and highlight. */
export async function performType(
    target: chrome.debugger.Debuggee,
    backendNodeId: number | undefined,
    text: string,
    opts: { fast: boolean },
): Promise<ActionResult> {
    let axInfo: AxInfo = {};
    if (backendNodeId != null) {
        await scrollIntoViewWithRetry(target, backendNodeId);
        const box = await resolveNodeBounds(target, backendNodeId);
        const [, resolvedAxInfo] = await Promise.all([
            (async () => {
                try {
                    await sendCommand(target, "DOM.focus", { backendNodeId });
                } catch {}
                if (box) {
                    await sendCommand(target, "Input.dispatchMouseEvent", {
                        type: "mousePressed",
                        x: box.x + box.w / 2,
                        y: box.y + box.h / 2,
                        button: "left",
                        clickCount: 1,
                    });
                    await sendCommand(target, "Input.dispatchMouseEvent", {
                        type: "mouseReleased",
                        x: box.x + box.w / 2,
                        y: box.y + box.h / 2,
                        button: "left",
                        clickCount: 1,
                    });
                }
            })(),
            getAxInfoForNode(target, backendNodeId),
        ]);
        axInfo = resolvedAxInfo;
        if (box) {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            await runCanvasOverlay(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await sleep(350);
            void runCanvasOverlay(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
            setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);
        }
    }

    const targetLabel = axInfo.name ?? axInfo.role ?? "Focused field";
    showHud(
        target,
        classifyHudAction("type", axInfo),
        targetLabel,
        `Typing ${text.length} character${text.length === 1 ? "" : "s"}`,
        opts.fast,
    );

    if (opts.fast) {
        await sendCommand(target, "Input.insertText", { text });
    } else {
        const chars = Array.from(text);
        const perCharDelayMs = chars.length > 40 ? 15 : 35;
        for (const ch of chars) {
            await sendCommand(target, "Input.insertText", { text: ch });
            if (perCharDelayMs > 0) await sleep(perCharDelayMs);
        }
    }
    await waitForStableDom(target);

    if (backendNodeId != null && text.length > 0) {
        let isNativeInput = false;
        try {
            const resolved = await sendCommand(target, "DOM.resolveNode", { backendNodeId });
            const objectId = resolved?.object?.objectId;
            if (objectId) {
                const tagRes = await sendCommand(target, "Runtime.callFunctionOn", {
                    objectId,
                    functionDeclaration: "function () { return this.tagName; }",
                    returnByValue: true,
                });
                const tag = tagRes?.result?.value;
                isNativeInput = tag === "INPUT" || tag === "TEXTAREA";
            }
        } catch {}

        if (isNativeInput) {
            let landed = await readElementText(target, backendNodeId);
            if (landed == null || !landed.includes(text)) {
                try {
                    await sendCommand(target, "DOM.focus", { backendNodeId });
                    await sendCommand(target, "Input.insertText", { text });
                    await waitForStableDom(target);
                    landed = await readElementText(target, backendNodeId);
                } catch {}

                if (landed == null || !landed.includes(text)) {
                    return {
                        error: `Typed "${text}" but it didn't land in the target element`,
                        hint: "The element likely lost focus mid-type. Take a fresh snapshot and retry.",
                    };
                }
            }
        }
    }

    return withRiskWarning(
        {
            success: true,
            message: `Typed "${text}"`,
            role: axInfo.role,
            name: axInfo.name,
        },
        axInfo,
        "typed into",
    );
}

function computeSingleCharKeyDef(
    ch: string,
): { key: string; code: string; keyCode: number; text?: string } | undefined {
    if (/[a-zA-Z]/.test(ch)) {
        return {
            key: ch,
            code: `Key${ch.toUpperCase()}`,
            keyCode: ch.toUpperCase().charCodeAt(0),
        };
    }
    if (/[0-9]/.test(ch)) {
        return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
    }
    const symbolCode = SINGLE_CHAR_SYMBOL_CODES[ch];
    if (symbolCode) {
        return { key: ch, code: symbolCode, keyCode: ch.charCodeAt(0) };
    }
    return undefined;
}

/** Dispatches a single key press (keydown/keyup sequence) to focused or targeted element. */
export async function performPressKey(
    target: chrome.debugger.Debuggee,
    key: string,
    backendNodeId: number | undefined,
    opts: { fast: boolean },
): Promise<ActionResult> {
    const def = KEY_DEFS[key] ?? (key.length === 1 ? computeSingleCharKeyDef(key) : undefined);
    if (!def)
        return {
            error: `Unsupported key: "${key}"`,
            hint: `Supported named keys: ${SUPPORTED_KEYS.join(", ")}. A single character (letter, digit, or common symbol) also works directly.`,
        };

    let axInfo: AxInfo = {};
    if (backendNodeId != null) {
        await scrollIntoViewWithRetry(target, backendNodeId);
        const box = await resolveNodeBounds(target, backendNodeId);
        const [, resolvedAxInfo] = await Promise.all([
            (async () => {
                try {
                    await sendCommand(target, "DOM.focus", { backendNodeId });
                } catch {
                    if (box) {
                        await sendCommand(target, "Input.dispatchMouseEvent", {
                            type: "mousePressed",
                            x: box.x + box.w / 2,
                            y: box.y + box.h / 2,
                            button: "left",
                            clickCount: 1,
                        });
                        await sendCommand(target, "Input.dispatchMouseEvent", {
                            type: "mouseReleased",
                            x: box.x + box.w / 2,
                            y: box.y + box.h / 2,
                            button: "left",
                            clickCount: 1,
                        });
                    }
                }
            })(),
            getAxInfoForNode(target, backendNodeId),
        ]);
        axInfo = resolvedAxInfo;
        if (box) {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            await runCanvasOverlay(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await sleep(350);
            void runCanvasOverlay(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
            setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);
        }
    }

    const hudAction = def.key === "Enter" ? "enter" : "key";
    showHud(
        target,
        hudAction,
        def.key === "Enter" ? "Submit with Enter" : `Press ${def.key}`,
        axInfo.name ? `On ${axInfo.name}` : "Keyboard input",
        opts.fast,
    );
    void runCanvasOverlay(target, `(${showKeyMotion.toString()})(${opts.fast})`, true);

    await sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code,
    });
    if (def.text) {
        await sendCommand(target, "Input.dispatchKeyEvent", {
            type: "char",
            text: def.text,
            unmodifiedText: def.text,
        });
    }
    await sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code,
    });
    await waitForStableDom(target);
    return {
        success: true,
        message: `Pressed ${key}`,
        role: axInfo.role,
        name: axInfo.name,
    };
}

/** Dispatches a mouse wheel scroll on the target tab. */
export async function performScroll(
    target: chrome.debugger.Debuggee,
    deltaX: number,
    deltaY: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
    const direction = vertical ? (deltaY >= 0 ? "down" : "up") : deltaX >= 0 ? "right" : "left";
    const distance = Math.round(Math.abs(vertical ? deltaY : deltaX));
    showHud(target, "scroll", `Scroll ${direction}`, `${distance}px`, opts.fast);
    void runCanvasOverlay(target, `(${showScrollMotion.toString()})(${deltaX},${deltaY},${opts.fast})`, true);
    await sendCommand(
        target,
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 500, y: 500, deltaX, deltaY },
        { retryOnTimeout: true },
    );
    await waitForStableDom(target);
    return { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
}

let lastCursorPosition: Point = { x: 400, y: 300 };

export function getLastCursorPosition(): Point {
    return { ...lastCursorPosition };
}

export function setLastCursorPosition(x: number, y: number): void {
    lastCursorPosition = { x: Math.round(x), y: Math.round(y) };
}

/** Performs a drag action following a straight, geometric, or multi-point trajectory path. */
export async function performDrag(
    target: chrome.debugger.Debuggee,
    fromX?: number,
    fromY?: number,
    toX?: number,
    toY?: number,
    opts: DragOptions = { fast: false },
): Promise<ActionResult> {
    let points: Point[];
    if (opts.points && opts.points.length >= 2) {
        points = opts.points;
    } else {
        const startX = fromX ?? opts.currentCursor?.x ?? lastCursorPosition.x;
        const startY = fromY ?? opts.currentCursor?.y ?? lastCursorPosition.y;
        const endX = toX ?? startX;
        const endY = toY ?? startY;
        const steps = Math.max(4, opts.stepsCount ?? 12);
        points = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            points.push({
                x: Math.round(startX + (endX - startX) * t),
                y: Math.round(startY + (endY - startY) * t),
            });
        }
    }

    const start = points[0];
    const end = points[points.length - 1];
    if (!start || !end) {
        return {
            error: "Drag trajectory requires at least 2 points",
            hint: "Check coordinates (fromX/fromY/toX/toY) or points array.",
        };
    }
    const button = opts.button ?? "left";

    showHud(
        target,
        "drag",
        `Drag to ${Math.round(end.x)}, ${Math.round(end.y)}`,
        `From ${Math.round(start.x)}, ${Math.round(start.y)} · ${points.length} points`,
        opts.fast,
    );
    void runCanvasOverlay(target, `(${showDragTrajectory.toString()})(${JSON.stringify(points)},${opts.fast})`, true);

    // 1. Move cursor to start
    await runCanvasOverlay(target, `(${moveCursorTo.toString()})(${start.x}, ${start.y}, ${opts.fast})`, true);
    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(true)`);

    // 2. Mouse Press
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.x,
        y: start.y,
        button,
        clickCount: 1,
    });

    // 3. Move through trajectory points (subsample if points > 24 to prevent CDP queue flooding)
    const maxCdpPoints = opts.fast ? 8 : 24;
    const stepRatio = Math.max(1, Math.floor(points.length / maxCdpPoints));
    const cdpPoints: Point[] = [];
    for (let i = 1; i < points.length - 1; i += stepRatio) {
        cdpPoints.push(points[i]!);
    }
    cdpPoints.push(end);

    const perStepDelay = opts.fast ? 0 : Math.max(8, Math.min(30, Math.round(200 / cdpPoints.length)));
    for (let i = 0; i < cdpPoints.length; i++) {
        const pt = cdpPoints[i]!;
        await sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pt.x,
            y: pt.y,
            button,
        });
        if (perStepDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, perStepDelay));
        }
    }

    await runCanvasOverlay(target, `(${moveCursorTo.toString()})(${end.x}, ${end.y}, true)`, true);

    // 4. Ripple & Mouse Release
    void runCanvasOverlay(target, `(${showClickRipple.toString()})(${end.x}, ${end.y}, 'click', ${opts.fast})`);
    void runCanvasOverlay(target, `(${pulseCursorPress.toString()})(false)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: end.x,
        y: end.y,
        button,
        clickCount: 1,
    });
    setLastCursorPosition(end.x, end.y);
    await waitForStableDom(target);

    const shapeNote =
        opts.shape && opts.shape !== "straight" ? ` (${opts.shape} trajectory, ${points.length} points)` : "";
    return {
        success: true,
        message: `Dragged from (${start.x}, ${start.y}) to (${end.x}, ${end.y})${shapeNote}`,
    };
}

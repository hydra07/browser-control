/**
 * Core user input actions (click, type, press_key, scroll, drag) via CDP Input events,
 * paired with cursor movement, ripple effects, and visual overlays.
 */

import type { Point } from "@browsercontrol/shared";
import { evalOnPage, quadToBox, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import {
    hideNativeHighlight,
    KIND_COLORS,
    moveCursorTo,
    pageDelay,
    pulseCursorPress,
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

function classifyHudAction(kind: "click" | "type", axInfo: AxInfo): string {
    const target = `${axInfo.role ?? ""} ${axInfo.name ?? ""}`.toLowerCase();
    if (target.includes("search")) return "search";
    if (target.includes("combobox") || target.includes("listbox") || target.includes("select")) return "select";
    return kind;
}

function showHud(target: chrome.debugger.Debuggee, action: string, title: string, detail: string, fast: boolean): void {
    void evalOnPage(
        target,
        `(${showActionHud.toString()})(${JSON.stringify(action)},${JSON.stringify(title)},${JSON.stringify(detail)},${fast})`,
        true,
    );
}

/** role+name (not backendDOMNodeId, meaningless after a reload) so replay.ts can re-resolve "the button named X" against a fresh snapshot. */
export async function getAxInfoForNode(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<AxInfo> {
    const result = await sendCommand(target, "Accessibility.queryAXTree", {
        backendNodeId,
    });
    const node = result?.nodes?.[0];
    return { role: node?.role?.value, name: node?.name?.value };
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
            functionDeclaration: "function () { return this.value ?? this.textContent ?? ''; }",
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
        await pageDelay(target, 300);
        await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId,
        });
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

/** Performs a left click with cursor glide, ripple, and risk inspection. */
export async function performClick(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    await scrollIntoViewWithRetry(target, backendNodeId);
    const boxModel = await sendCommand(target, "DOM.getBoxModel", {
        backendNodeId,
    });
    if (!boxModel?.model) {
        return {
            error: "Failed to resolve node bounds",
            hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry.",
        };
    }
    const box = quadToBox(boxModel.model.content);
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;

    const [, axInfo] = await Promise.all([
        evalOnPage(target, `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`, true),
        getAxInfoForNode(target, backendNodeId),
    ]);
    const targetLabel = axInfo.name ?? axInfo.role ?? "Page element";
    showHud(target, classifyHudAction("click", axInfo), targetLabel, `Clicking ${axInfo.role ?? "element"}`, opts.fast);
    await showNativeHighlight(target, box, KIND_COLORS.click.rgb);
    if (!opts.fast) await pageDelay(target, 350);

    void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    void evalOnPage(target, `(${showClickRipple.toString()})(${x}, ${y}, 'click', ${opts.fast})`);
    if (!opts.fast) await pageDelay(target, 130);
    void evalOnPage(target, `(${pulseCursorPress.toString()})(false)`);
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

        try {
            await sendCommand(target, "DOM.focus", { backendNodeId });
        } catch (e) {
            return {
                error: `Failed to focus node: ${errorMessage(e)}`,
                hint: "The node id may be stale, or the element isn't focusable (e.g. a div, not an input). Take a fresh snapshot and confirm it's an input/textbox node.",
            };
        }

        const [boxModel, resolvedAxInfo] = await Promise.all([
            sendCommand(target, "DOM.getBoxModel", { backendNodeId }),
            getAxInfoForNode(target, backendNodeId),
        ]);
        axInfo = resolvedAxInfo;
        if (boxModel?.model?.content) {
            const box = quadToBox(boxModel.model.content);
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            await evalOnPage(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await pageDelay(target, 350);
            void evalOnPage(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
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
            if (perCharDelayMs > 0) await pageDelay(target, perCharDelayMs);
        }
    }
    await waitForStableDom(target);

    if (backendNodeId != null && text.length > 0) {
        let landed = await readElementText(target, backendNodeId);
        if (landed == null || !landed.includes(text)) {
            // One recovery attempt: the node may still be attached, just
            // knocked out of focus by a re-render — re-focus and re-insert
            // before giving up on it.
            try {
                await sendCommand(target, "DOM.focus", { backendNodeId });
                await sendCommand(target, "Input.insertText", { text });
                await waitForStableDom(target);
                landed = await readElementText(target, backendNodeId);
            } catch {}

            if (landed == null || !landed.includes(text)) {
                return {
                    error: `Typed "${text}" but it didn't land in the target element`,
                    hint: "The element likely lost focus mid-type (a re-render replaced it, or something else grabbed focus). Take a fresh snapshot and retry, ideally right after the element becomes visible/interactive rather than immediately after the action that revealed it.",
                };
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
        try {
            await sendCommand(target, "DOM.focus", { backendNodeId });
        } catch (e) {
            return {
                error: `Failed to focus node: ${errorMessage(e)}`,
                hint: "The node id may be stale, or the element isn't focusable. Take a fresh snapshot and retry.",
            };
        }
        const [boxModel, resolvedAxInfo] = await Promise.all([
            sendCommand(target, "DOM.getBoxModel", { backendNodeId }),
            getAxInfoForNode(target, backendNodeId),
        ]);
        axInfo = resolvedAxInfo;
        if (boxModel?.model?.content) {
            const box = quadToBox(boxModel.model.content);
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            await evalOnPage(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await pageDelay(target, 350);
            void evalOnPage(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
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
    void evalOnPage(target, `(${showKeyMotion.toString()})(${opts.fast})`, true);

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
    void evalOnPage(target, `(${showScrollMotion.toString()})(${deltaX},${deltaY},${opts.fast})`, true);
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
    void evalOnPage(target, `(${showDragTrajectory.toString()})(${JSON.stringify(points)},${opts.fast})`, true);

    // 1. Move cursor to start
    await evalOnPage(target, `(${moveCursorTo.toString()})(${start.x}, ${start.y}, ${opts.fast})`, true);
    void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);

    // 2. Mouse Press
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.x,
        y: start.y,
        button,
        clickCount: 1,
    });

    // 3. Move through every calculated trajectory point
    const perStepDelay = opts.fast ? 0 : Math.max(5, Math.min(25, Math.round(250 / points.length)));
    for (let i = 1; i < points.length; i++) {
        const pt = points[i];
        await sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pt.x,
            y: pt.y,
            button,
        });
        if (!opts.fast && i % 2 === 0) {
            void evalOnPage(target, `(${moveCursorTo.toString()})(${pt.x}, ${pt.y}, true)`);
        }
        if (perStepDelay > 0) {
            await pageDelay(target, perStepDelay);
        }
    }

    await evalOnPage(target, `(${moveCursorTo.toString()})(${end.x}, ${end.y}, true)`, true);

    // 4. Ripple & Mouse Release
    void evalOnPage(target, `(${showClickRipple.toString()})(${end.x}, ${end.y}, 'click', ${opts.fast})`);
    void evalOnPage(target, `(${pulseCursorPress.toString()})(false)`);
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

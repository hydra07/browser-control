/**
 * Core user input actions (click, type, press_key, scroll, drag) via CDP Input events,
 * paired with cursor movement, ripple effects, and visual overlays.
 */

import type { Point } from "@browsercontrol/shared";
import { evalOnPage, evalOnPageWithResult, quadToBox, sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import {
    hideNativeHighlight,
    KIND_COLORS,
    moveCursorTo,
    pageDelay,
    pulseCursorPress,
    showClickRipple,
    showKeyBadge,
    showNativeHighlight,
    showScrollIndicator,
} from "../overlay/index.js";
import { waitForStableDom } from "../wait/index.js";
import { KEY_DEFS, RISKY_NAME_PATTERN, SINGLE_CHAR_SYMBOL_CODES, SUPPORTED_KEYS } from "./constants.js";
import type { ActionResult, AxInfo, DragOptions } from "./types.js";

export type { ActionResult, AxInfo, DragOptions } from "./types.js";

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

const SETTLE_WARNING =
    "The page was still changing when the settle window closed (animation, live content, or a slow navigation). The action itself was dispatched — check the page before repeating it.";

/**
 * A settle timeout only means the page kept mutating afterwards; the input
 * events were already delivered. Reporting it as an error made agents retry,
 * i.e. click or type twice, so it becomes a warning on a successful result.
 */
function settled<T extends Extract<ActionResult, { success: true }>>(result: T): ActionResult {
    if (result.settleReason === "timeout") result.warning = SETTLE_WARNING;
    return result;
}

/**
 * Picks the point to click: the centre of the part of the element that is
 * inside the viewport (a tall element's full-box centre can be off screen),
 * then hit-tests it so a cookie banner or modal sitting on top is reported
 * instead of silently receiving the click. Returns null coordinates plus a
 * description of the covering element when blocked.
 */
async function clickPoint(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
    box: { x: number; y: number; w: number; h: number },
): Promise<{ x: number; y: number; coveredBy?: string }> {
    const layout = await sendCommand(target, "Page.getLayoutMetrics").catch(() => null);
    const vw = layout?.cssLayoutViewport?.clientWidth ?? box.x + box.w;
    const vh = layout?.cssLayoutViewport?.clientHeight ?? box.y + box.h;
    const left = Math.max(box.x, 0);
    const top = Math.max(box.y, 0);
    const right = Math.min(box.x + box.w, vw);
    const bottom = Math.min(box.y + box.h, vh);
    const x = right > left ? (left + right) / 2 : box.x + box.w / 2;
    const y = bottom > top ? (top + bottom) / 2 : box.y + box.h / 2;
    try {
        const resolved = await sendCommand(target, "DOM.resolveNode", { backendNodeId });
        const objectId = resolved?.object?.objectId;
        if (!objectId) return { x, y };
        const res = await sendCommand(target, "Runtime.callFunctionOn", {
            objectId,
            arguments: [{ value: x }, { value: y }],
            returnByValue: true,
            functionDeclaration: `function (x, y) {
                if (this.ownerDocument !== document) return null;
                const hit = document.elementFromPoint(x, y);
                if (!hit || hit === this || this.contains(hit) || hit.contains(this)) return null;
                const label = hit.closest("label");
                if (label && (label.control === this || label.contains(this))) return null;
                const ownLabel = this.closest && this.closest("label");
                if (ownLabel && ownLabel.contains(hit)) return null;
                if (hit.closest('[id^="__bc_"], [class^="__bc_"]')) return null;
                const cls = typeof hit.className === "string" && hit.className.trim() ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
                const text = (hit.innerText || hit.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 60);
                return "<" + hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + cls + ">" + (text ? ' "' + text + '"' : "");
            }`,
        });
        void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(() => {});
        const coveredBy = res?.result?.value;
        return typeof coveredBy === "string" ? { x, y, coveredBy } : { x, y };
    } catch {
        return { x, y };
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
    opts: { fast: boolean; force?: boolean },
): Promise<ActionResult> {
    await scrollIntoViewWithRetry(target, backendNodeId);
    const boxModel = await sendCommand(target, "DOM.getBoxModel", {
        backendNodeId,
    }).catch(() => null);
    if (!boxModel?.model) {
        return {
            error: "Failed to resolve node bounds",
            hint: "The node id may be stale (page navigated/re-rendered since the last snapshot), or the element is not rendered. Take a fresh snapshot and retry.",
        };
    }
    const box = quadToBox(boxModel.model.content);
    const { x, y, coveredBy } = await clickPoint(target, backendNodeId, box);
    if (coveredBy && !opts.force) {
        return {
            error: `Click target is covered by ${coveredBy}`,
            hint: "Dismiss the overlay first (cookie banner, modal, sticky header), scroll, or retry with --force if the covering element is meant to receive the click.",
        };
    }

    const [, axInfo] = await Promise.all([
        evalOnPage(target, `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`, true),
        getAxInfoForNode(target, backendNodeId).catch((): AxInfo => ({})),
    ]);
    await showNativeHighlight(target, box, KIND_COLORS.click.rgb);
    if (!opts.fast) await pageDelay(target, 350);

    // A real pointer arrives before it presses: hover menus, tooltips and pointerenter-gated buttons need this move.
    await sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
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
    const settleResult = await waitForStableDom(target);
    setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);

    return withRiskWarning(
        settled({
            success: true,
            message: `Clicked at (${Math.round(x)}, ${Math.round(y)})`,
            role: axInfo.role,
            name: axInfo.name,
            settleReason: settleResult.reason,
        }),
        axInfo,
        "clicked",
    );
}

/** Selects the element's current content so the next insertText replaces it instead of appending. */
async function selectElementContents(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<void> {
    const resolved = await sendCommand(target, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return;
    await sendCommand(target, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () {
            if (typeof this.select === "function" && "value" in this) { this.select(); return; }
            if (this.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(this);
                const sel = getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }`,
    });
    void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(() => {});
}

/** Types text into a targeted element (or currently focused input) with cursor glide and highlight. */
export async function performType(
    target: chrome.debugger.Debuggee,
    backendNodeId: number | undefined,
    text: string,
    opts: { fast: boolean; clear?: boolean },
): Promise<ActionResult> {
    let axInfo: AxInfo = {};
    if (backendNodeId != null) {
        await scrollIntoViewWithRetry(target, backendNodeId);

        try {
            await sendCommand(target, "DOM.focus", { backendNodeId });
        } catch (e) {
            return {
                error: `Failed to focus node: ${errorMessage(e)}`,
                hint: "The node id may be stale, or the element isn't focusable (e.g. a label or div, not an input). Take a fresh snapshot and pass the textbox's id.",
            };
        }
        if (opts.clear) await selectElementContents(target, backendNodeId).catch(() => {});

        const [boxModel, resolvedAxInfo] = await Promise.all([
            sendCommand(target, "DOM.getBoxModel", { backendNodeId }).catch(() => null),
            getAxInfoForNode(target, backendNodeId).catch((): AxInfo => ({})),
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

    if (opts.clear && text === "") {
        await dispatchKey(target, KEY_DEFS.Delete, 0);
    } else if (opts.fast) {
        await sendCommand(target, "Input.insertText", { text });
    } else {
        const chars = Array.from(text);
        const perCharDelayMs = chars.length > 40 ? 15 : 35;
        for (const ch of chars) {
            await sendCommand(target, "Input.insertText", { text: ch });
            if (perCharDelayMs > 0) await pageDelay(target, perCharDelayMs);
        }
    }
    let settleReason = (await waitForStableDom(target)).reason;

    if (backendNodeId != null && text.length > 0) {
        let landed = await readElementText(target, backendNodeId);
        if (landed == null || !landed.includes(text)) {
            // One recovery attempt: the node may still be attached, just
            // knocked out of focus by a re-render — re-focus and re-insert
            // before giving up on it.
            try {
                await sendCommand(target, "DOM.focus", { backendNodeId });
                await sendCommand(target, "Input.insertText", { text });
                settleReason = (await waitForStableDom(target)).reason;
                landed = await readElementText(target, backendNodeId);
            } catch {}

            if (landed == null || !landed.includes(text)) {
                return {
                    error: `Typed ${text.length} chars but they didn't land in the target element`,
                    hint: "The element likely lost focus mid-type (a re-render replaced it, or something else grabbed focus). Take a fresh snapshot and retry, ideally right after the element becomes visible/interactive rather than immediately after the action that revealed it.",
                    settleReason,
                };
            }
        }
    }
    // The typed text is deliberately not echoed back: it may be a password, and the caller already has it.
    return withRiskWarning(
        settled({
            success: true,
            message: `${opts.clear ? "Replaced value with" : "Typed"} ${text.length} chars`,
            role: axInfo.role,
            name: axInfo.name,
            settleReason,
        }),
        axInfo,
        "typed into",
    );
}

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

/** CDP modifier bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
const MODIFIER_BITS: Record<string, number> = {
    alt: 1,
    option: 1,
    control: 2,
    ctrl: 2,
    meta: 4,
    cmd: 4,
    command: 4,
    shift: 8,
};

async function dispatchKey(target: chrome.debugger.Debuggee, def: KeyDef, modifiers: number): Promise<void> {
    // Text is only produced without Control/Alt/Meta: "Control+a" must select-all, not insert "a".
    const text = modifiers & 0b111 ? undefined : def.text;
    await sendCommand(target, "Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        modifiers,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code,
        ...(text ? { text, unmodifiedText: text } : {}),
    });
    await sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code,
    });
}

/** Parses "Enter", "a", "Control+Shift+K", "Meta+Enter" into a key definition plus modifier bits. */
export function parseKeyCombo(combo: string): { def: KeyDef; modifiers: number } | null {
    const parts = combo.split("+");
    const keyName = parts.length > 1 && parts[parts.length - 1] === "" ? "+" : (parts.pop() ?? "");
    let modifiers = 0;
    for (const part of parts) {
        if (part === "") continue;
        const bit = MODIFIER_BITS[part.toLowerCase()];
        if (bit == null) return null;
        modifiers |= bit;
    }
    let def: KeyDef | undefined =
        KEY_DEFS[keyName] ?? (Array.from(keyName).length === 1 ? computeSingleCharKeyDef(keyName) : undefined);
    if (!def) return null;
    if (modifiers & MODIFIER_BITS.shift && def.text && /^[a-z]$/.test(def.text)) {
        def = { ...def, key: def.text.toUpperCase(), text: def.text.toUpperCase() };
    }
    return { def, modifiers };
}

function computeSingleCharKeyDef(ch: string): KeyDef | undefined {
    if (/[a-zA-Z]/.test(ch)) {
        return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
    }
    if (/[0-9]/.test(ch)) {
        return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }
    const symbolCode = SINGLE_CHAR_SYMBOL_CODES[ch];
    if (symbolCode) {
        return { key: ch, code: symbolCode, keyCode: ch.charCodeAt(0), text: ch };
    }
    // Any other printable character (shifted symbols, non-Latin letters): no physical key code, just its text.
    return /\S/u.test(ch) ? { key: ch, code: "", keyCode: 0, text: ch } : undefined;
}

/** Dispatches a key or key combo ("Control+a", "Shift+Tab") to the focused or targeted element. */
export async function performPressKey(
    target: chrome.debugger.Debuggee,
    key: string,
    backendNodeId: number | undefined,
    opts: { fast: boolean },
): Promise<ActionResult> {
    const parsed = parseKeyCombo(key);
    if (!parsed)
        return {
            error: `Unsupported key: "${key}"`,
            hint: `Supported named keys: ${SUPPORTED_KEYS.join(", ")}, any single character, optionally prefixed with Control+/Shift+/Alt+/Meta+ (e.g. "Control+a").`,
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
            sendCommand(target, "DOM.getBoxModel", { backendNodeId }).catch(() => null),
            getAxInfoForNode(target, backendNodeId).catch((): AxInfo => ({})),
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
    } else {
        void evalOnPage(target, `(${showKeyBadge.toString()})(${JSON.stringify(key)}, ${opts.fast})`);
    }

    await dispatchKey(target, parsed.def, parsed.modifiers);
    const settleResult = await waitForStableDom(target);
    return settled({
        success: true,
        message: `Pressed ${key}`,
        role: axInfo.role,
        name: axInfo.name,
        settleReason: settleResult.reason,
    });
}

/**
 * Dispatches a mouse wheel. Without a node it lands on the viewport centre (a
 * fixed (500,500) missed small viewports and often hit a non-scrolling overlay);
 * with a node it lands on that element, which is how inner scroll containers
 * (chat logs, sidebars, virtualised lists) are scrolled. Reports the resulting
 * window position so a caller can tell when it hit the end.
 */
export async function performScroll(
    target: chrome.debugger.Debuggee,
    deltaX: number,
    deltaY: number,
    opts: { fast: boolean; backendNodeId?: number },
): Promise<ActionResult> {
    let x: number;
    let y: number;
    if (opts.backendNodeId != null) {
        const model = await sendCommand(target, "DOM.getBoxModel", { backendNodeId: opts.backendNodeId }).catch(
            () => null,
        );
        if (!model?.model) {
            return {
                error: "Failed to resolve the scroll container's bounds",
                hint: "Take a fresh snapshot and pass the id of the scrollable element (list, panel, chat log).",
            };
        }
        const box = quadToBox(model.model.content);
        x = box.x + box.w / 2;
        y = box.y + box.h / 2;
    } else {
        const layout = await sendCommand(target, "Page.getLayoutMetrics").catch(() => null);
        x = (layout?.cssLayoutViewport?.clientWidth ?? 1000) / 2;
        y = (layout?.cssLayoutViewport?.clientHeight ?? 1000) / 2;
    }
    void evalOnPage(target, `(${showScrollIndicator.toString()})(${deltaX}, ${deltaY}, ${opts.fast})`);
    await sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await sendCommand(
        target,
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x, y, deltaX, deltaY },
        { retryOnTimeout: true },
    );
    const settleResult = await waitForStableDom(target);
    const position = await evalOnPageWithResult<{ y: number; max: number }>(
        target,
        "({ y: Math.round(window.scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)) })",
    );
    const where =
        position && opts.backendNodeId == null
            ? `; page at y=${position.y}/${position.max}${position.y >= position.max - 2 ? " (bottom)" : ""}`
            : "";
    return settled({
        success: true,
        message: `Scrolled by (${deltaX}, ${deltaY})${where}`,
        settleReason: settleResult.reason,
    });
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

    // 1. Move cursor to start
    await evalOnPage(target, `(${moveCursorTo.toString()})(${start.x}, ${start.y}, ${opts.fast})`, true);
    void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);

    // 2. Hover the start point, then press (drag sources often arm on pointerenter/mousemove)
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x,
        y: start.y,
        button: "none",
    });
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
    const settleResult = await waitForStableDom(target);
    const shapeNote =
        opts.shape && opts.shape !== "straight" ? ` (${opts.shape} trajectory, ${points.length} points)` : "";
    return settled({
        success: true,
        message: `Dragged from (${start.x}, ${start.y}) to (${end.x}, ${end.y})${shapeNote}`,
        settleReason: settleResult.reason,
    });
}

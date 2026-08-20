// Shared implementations behind the standalone click/type/press_key/scroll
// commands AND their run_flow/explore_flow step equivalents (lib/flow.ts
// calls these with opts.fast:true). Each pairs a real CDP input event with
// the matching lib/overlay.ts visual feedback so an AI-driven action is
// followable live and in a browser_start_recording capture.
import { sendCommand, errorMessage, evalOnPage, quadToBox } from "./cdp.js";
import { waitForStableDom } from "./wait.js";
import {
    KIND_COLORS,
    moveCursorTo,
    pulseCursorPress,
    showClickRipple,
    showNativeHighlight,
    hideNativeHighlight,
    pageDelay,
    showScrollIndicator,
    showKeyBadge,
} from "./overlay.js";

export type AxInfo = { role?: string; name?: string };
export type ActionResult =
    | {
          success: true;
          message: string;
          role?: string;
          name?: string;
          _riskWarning?: string;
      }
    | { error: string; hint?: string };

/** role+name (not backendDOMNodeId, meaningless after a reload) so replay.ts can re-resolve "the button named X" against a fresh snapshot. */
export async function getAxInfoForNode(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
): Promise<AxInfo> {
    const result = await sendCommand(target, "Accessibility.queryAXTree", {
        backendNodeId,
    });
    const node = result?.nodes?.[0];
    return { role: node?.role?.value, name: node?.name?.value };
}

// Flags a target whose accessible name suggests a destructive/irreversible
// action. Standalone click/type attach this as an advisory `_riskWarning`
// (the AI was told to act on this one element); run_flow/explore_flow use
// it to BLOCK a step by default (lib/flow.ts) since those steps come from
// the AI's own guess rather than a direct instruction.
const RISKY_NAME_PATTERN =
    /delete|remove|uninstall|deactivate|cancel|unsubscribe|sign\s*out|log\s*out|pay|purchase|confirm|permanently/i;

export function isRiskyTarget(axInfo: AxInfo): boolean {
    return !!axInfo.name && RISKY_NAME_PATTERN.test(axInfo.name);
}

export function withRiskWarning(
    result: ActionResult,
    axInfo: AxInfo,
    verb: string,
): ActionResult {
    if ("success" in result && isRiskyTarget(axInfo)) {
        result._riskWarning = `This ${verb} ${axInfo.role ?? "element"} "${axInfo.name}", which looks potentially destructive/irreversible.`;
    }
    return result;
}

// opts.fast trims the animation (shorter glide, no aim-pause, shorter
// ripple/highlight) so a multi-step flow finishes well inside the daemon's
// fixed command timeout, without changing the standalone commands' timing.
export async function performClick(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    await sendCommand(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
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
        evalOnPage(
            target,
            `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`,
            true,
        ),
        getAxInfoForNode(target, backendNodeId),
    ]);
    await showNativeHighlight(target, box, KIND_COLORS.click.rgb);
    // Beat between "cursor arrived, target highlighted" and mousedown —
    // without it the glide finishing and the click read as one instant blip.
    if (!opts.fast) await pageDelay(target, 350);

    void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
    });
    void evalOnPage(
        target,
        `(${showClickRipple.toString()})(${x}, ${y}, 'click', ${opts.fast})`,
    );
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

// backendNodeId is optional — without one this types into whatever is
// already focused (e.g. right after a click), matching the standalone
// command's documented behavior.
export async function performType(
    target: chrome.debugger.Debuggee,
    backendNodeId: number | undefined,
    text: string,
    opts: { fast: boolean },
): Promise<ActionResult> {
    let axInfo: AxInfo = {};
    if (backendNodeId != null) {
        await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId,
        });

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
            await evalOnPage(
                target,
                `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`,
                true,
            );
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await pageDelay(target, 350);
            void evalOnPage(
                target,
                `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`,
            );
            setTimeout(
                () => hideNativeHighlight(target),
                opts.fast ? 350 : 1200,
            );
        }
    }

    // Outside fast mode, types one character at a time (Array.from, so
    // multi-byte characters survive) instead of one bulk insertText, so it
    // reads as typing rather than the string just appearing. Flow steps
    // (fast) skip that and insert in one call — throughput over demo.
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

// Input.dispatchKeyEvent needs a real (key, code, Windows virtual key code)
// triple per key — no generic "just send Enter" shortcut in CDP. `text` is
// only set for keys that should also fire a synthesized `char` event.
const KEY_DEFS: Record<
    string,
    { key: string; code: string; keyCode: number; text?: string }
> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
export const SUPPORTED_KEYS = Object.keys(KEY_DEFS);

// US-layout best-effort — enough to cover the common case (canvas apps like
// Excalidraw binding tool-select shortcuts to single letters: 'r' for
// rectangle, 'o' for ellipse, etc.), not a full keyboard-layout emulation.
// A single character not in KEY_DEFS falls through here instead of erroring,
// so press_key isn't limited to the fixed named-key list above.
const SINGLE_CHAR_SYMBOL_CODES: Record<string, string> = {
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "`": "Backquote",
};

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
// Deliberately no `text` on any of these — press_key's job is firing the
// key event a shortcut listener reacts to (keydown/keyup only), not
// inserting a character into a focused field; that's browser_type's job.
// KEY_DEFS' Space/Enter above are the exception (need `text` to reproduce
// real browser behavior for those two specifically), not the rule.

export async function performPressKey(
    target: chrome.debugger.Debuggee,
    key: string,
    backendNodeId: number | undefined,
    opts: { fast: boolean },
): Promise<ActionResult> {
    const def =
        KEY_DEFS[key] ?? (key.length === 1 ? computeSingleCharKeyDef(key) : undefined);
    if (!def)
        return {
            error: `Unsupported key: "${key}"`,
            hint: `Supported named keys: ${SUPPORTED_KEYS.join(", ")}. A single character (letter, digit, or common symbol) also works directly.`,
        };

    let axInfo: AxInfo = {};
    if (backendNodeId != null) {
        await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId,
        });
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
            await evalOnPage(
                target,
                `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`,
                true,
            );
            await showNativeHighlight(target, box, KIND_COLORS.type.rgb);
            if (!opts.fast) await pageDelay(target, 350);
            void evalOnPage(
                target,
                `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`,
            );
            setTimeout(
                () => hideNativeHighlight(target),
                opts.fast ? 350 : 1200,
            );
        }
    } else {
        // No target — the common browser_type -> Enter pattern (nodeId
        // omitted because browser_type's focus is still active). No box to
        // glide/highlight, so show a badge instead of nothing.
        void evalOnPage(
            target,
            `(${showKeyBadge.toString()})(${JSON.stringify(def.key)}, ${opts.fast})`,
        );
    }

    // rawKeyDown+keyUp always fire; the synthesized `char` event between them
    // is what inserts a character for keys like Space — Enter/Tab/arrows/
    // Escape have no `text` and so only fire key events, matching a real
    // browser's behavior for non-printing keys.
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

// Scroll has no single element to point a cursor/highlight at, so it uses
// showScrollIndicator instead of moveCursorTo/showNativeHighlight.
export async function performScroll(
    target: chrome.debugger.Debuggee,
    deltaX: number,
    deltaY: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    void evalOnPage(
        target,
        `(${showScrollIndicator.toString()})(${deltaX}, ${deltaY}, ${opts.fast})`,
    );
    // Wheel events need x,y to apply at — center screen is as good as any
    // single point for a whole-page scroll.
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 500,
        y: 500,
        deltaX,
        deltaY,
    });
    await waitForStableDom(target);
    return { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
}

// For canvas-based UI (a whiteboard, a drawing app) where there's no DOM
// element per shape to click/type into — click/type/press_key all resolve
// a target by nodeId; this is the one action addressed by raw viewport
// coordinates instead, a real mousedown->mousemove(*n)->mouseup sequence
// (not a single jump) so the target sees an actual drag path, which matters
// for anything that tracks drag distance/velocity, not just start/end.
export async function performDrag(
    target: chrome.debugger.Debuggee,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts: { fast: boolean },
): Promise<ActionResult> {
    await evalOnPage(
        target,
        `(${moveCursorTo.toString()})(${fromX}, ${fromY}, ${opts.fast})`,
        true,
    );
    void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: fromX,
        y: fromY,
        button: "left",
        clickCount: 1,
    });

    // Real intermediate points, not a teleport — fast mode still moves
    // through them (functionally required for a real drag), just skips the
    // per-step pacing delay and the visual cursor's follow-along glide.
    const steps = opts.fast ? 6 : 14;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = fromX + (toX - fromX) * t;
        const y = fromY + (toY - fromY) * t;
        await sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
            button: "left",
        });
        if (!opts.fast) {
            void evalOnPage(target, `(${moveCursorTo.toString()})(${x}, ${y}, true)`);
            await pageDelay(target, 20);
        }
    }

    void evalOnPage(
        target,
        `(${showClickRipple.toString()})(${toX}, ${toY}, 'click', ${opts.fast})`,
    );
    void evalOnPage(target, `(${pulseCursorPress.toString()})(false)`);
    await sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: toX,
        y: toY,
        button: "left",
        clickCount: 1,
    });
    await waitForStableDom(target);

    return {
        success: true,
        message: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`,
    };
}

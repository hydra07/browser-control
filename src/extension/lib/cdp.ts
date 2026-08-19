// Every chrome.debugger.sendCommand call used to be hand-wrapped in
// `new Promise((resolve) => chrome.debugger.sendCommand(...))` with the
// result typed `any` — @types/chrome has no way to link a CDP method string
// to its actual response shape. This wrapper does that linkage manually via
// an explicit type parameter backed by devtools-protocol's Protocol
// namespace (the same source of truth Chrome's own DevTools frontend is
// generated from), and folds the repeated Promise-wrapping into one place.

import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

// Found via a real session: Input.dispatchMouseEvent during an Excalidraw
// drag, and Page.captureScreenshot shortly after a same-tab location.reload(),
// each left chrome.debugger.sendCommand's callback never firing — no CDP
// error, no exception, just silence. Every awaiting caller hung until the
// daemon's own outer executeCommand timeout (15s) gave up with zero
// indication of which step was actually stuck. Bounding every command here
// means a wedged callback fails fast and names itself instead of silently
// eating the whole request budget.
const CDP_COMMAND_TIMEOUT_MS = 10000;

export function sendCommand<M extends keyof ProtocolMapping.Commands>(
    target: chrome.debugger.Debuggee,
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
                new Error(
                    `CDP ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms — Chrome's debugger backend never responded (the page/tab may be busy or wedged).`,
                ),
            );
        }, CDP_COMMAND_TIMEOUT_MS);
        chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
            if (settled) return; // Late callback after our own timeout already rejected — ignore.
            settled = true;
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`CDP ${method} failed: ${err.message}`));
            else resolve(result as ProtocolMapping.Commands[M]["returnType"]);
        });
    });
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// A CDP DOM.Quad is 4 (x,y) corner pairs, not necessarily axis-aligned
// (elements can be rotated/skewed) — collapsing to a bounding box is what
// every caller actually wants (a rect to draw a highlight/cursor-glide
// target at), not the raw quad. Shared by both the click/type/press_key
// action animations (lib/overlay.ts) and screenshot annotation
// (lib/screenshot.ts) — a plain CDP-geometry helper, not specific to either.
export function quadToBox(quad: Protocol.DOM.Quad): {
    x: number;
    y: number;
    w: number;
    h: number;
} {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Every visual-feedback injection (cursor/highlight/ripple/annotation
// overlay) used to go through a bare chrome.debugger.sendCommand(..., resolve)
// that ignored the result entirely — if the injected code threw (or the
// command itself failed), we'd silently move on with no visual effect and
// zero trace of why. Route them all through here so failures show up in the
// extension's own service worker console (chrome://extensions → "service
// worker" link) instead of just quietly not happening.
export async function evalOnPage(
    target: chrome.debugger.Debuggee,
    expression: string,
    awaitPromise = false,
): Promise<void> {
    try {
        const evalResult = await sendCommand(target, "Runtime.evaluate", {
            expression,
            awaitPromise,
        });
        if (evalResult?.exceptionDetails) {
            console.error(
                "[browsercontrol] visual feedback script threw:",
                evalResult.exceptionDetails.exception?.description ??
                    evalResult.exceptionDetails.text,
            );
        }
    } catch (e) {
        console.error(
            "[browsercontrol] visual feedback command failed:",
            errorMessage(e),
        );
    }
}

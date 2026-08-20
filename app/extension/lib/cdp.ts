// Promise wrapper for chrome.debugger.sendCommand, typed against
// devtools-protocol's ProtocolMapping so a CDP method name resolves to its
// real params/return types instead of `any`.

import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

// chrome.debugger.sendCommand's callback can just never fire (seen with
// Input.dispatchMouseEvent mid-drag, and Page.captureScreenshot right after
// a same-tab reload) — no error, no exception, just silence. This bounds
// every command so a wedged one fails fast and names itself.
const CDP_COMMAND_TIMEOUT_MS = 10000;

function sendCommandOnce<M extends keyof ProtocolMapping.Commands>(
    target: chrome.debugger.Debuggee,
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0] | undefined,
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

export function sendCommand<M extends keyof ProtocolMapping.Commands>(
    target: chrome.debugger.Debuggee,
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
    opts?: { retryOnTimeout?: boolean },
): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    const attempt = () => sendCommandOnce(target, method, params);
    if (!opts?.retryOnTimeout) return attempt();
    // Only safe for commands whose effect is harmless to fire twice
    // (e.g. a wheel scroll) — chrome.debugger.sendCommand's callback can
    // just never fire (see CDP_COMMAND_TIMEOUT_MS above), and that's
    // frequently a lost ack rather than a command that never reached
    // Chrome at all, so one retry after a timeout clears most of these.
    // Never opt a command with a real side effect that shouldn't double
    // fire (mousePressed/mouseReleased, dispatchKeyEvent, etc.) into this.
    return attempt().catch((e) => {
        console.warn(
            `[browsercontrol] CDP ${method} timed out, retrying once:`,
            errorMessage(e),
        );
        return attempt();
    });
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// A DOM.Quad is 4 (x,y) corner pairs (elements can be rotated/skewed) —
// collapses to the bounding box callers actually want for a highlight/
// cursor target. Shared by overlay.ts and screenshot.ts.
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

// Runs injected visual-feedback scripts (cursor/highlight/ripple/badges)
// and logs any exception to the service worker console (chrome://extensions
// → "service worker") instead of failing silently.
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

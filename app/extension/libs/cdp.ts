/** Typed Promise wrapper for chrome.debugger.sendCommand. */
import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import { errorMessage } from "./errorMessage.js";

const CDP_COMMAND_TIMEOUT_MS = 10000;

type ReattachFn = (tabId: number) => Promise<void>;
let reattachHook: ReattachFn | null = null;
let detachListener: ((tabId: number) => void) | null = null;

export function setDebuggerHooks(hooks: { onDetached?: (tabId: number) => void; reattach?: ReattachFn }): void {
    if (hooks.onDetached) detachListener = hooks.onDetached;
    if (hooks.reattach) reattachHook = hooks.reattach;
}

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
                    `CDP ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms — Chrome's debugger backend never responded.`,
                ),
            );
        }, CDP_COMMAND_TIMEOUT_MS);
        chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) {
                const message = err.message ?? "unknown error";
                if (target.tabId != null && message.includes("Debugger is not attached")) {
                    detachListener?.(target.tabId);
                }
                reject(new Error(`CDP ${method} failed: ${message}`));
            } else {
                resolve(result as ProtocolMapping.Commands[M]["returnType"]);
            }
        });
    });
}

/** Execute a CDP command with timeout bounding, auto-reattach recovery, and optional idempotent retry. */
export async function sendCommand<M extends keyof ProtocolMapping.Commands>(
    target: chrome.debugger.Debuggee,
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
    opts?: { retryOnTimeout?: boolean },
): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    const attempt = () => sendCommandOnce(target, method, params);
    try {
        return await attempt();
    } catch (e) {
        const msg = errorMessage(e);
        // If debugger was detached (e.g. cross-origin navigation / process swap), re-attach and retry once
        if (target.tabId != null && reattachHook && msg.includes("Debugger is not attached")) {
            console.warn(`[browsercontrol] Debugger detached before ${method} on tab ${target.tabId}, re-attaching...`);
            await reattachHook(target.tabId).catch(() => {});
            return await attempt();
        }
        if (opts?.retryOnTimeout && msg.includes("timed out")) {
            console.warn(`[browsercontrol] CDP ${method} timed out, retrying once:`, msg);
            return await attempt();
        }
        throw e;
    }
}

/** Converts a 4-point DOM.Quad into an axis-aligned bounding box {x, y, w, h}. */
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

/** Runs injected visual feedback expressions on the target page. */
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
                evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails.text,
            );
        }
    } catch (e) {
        const msg = errorMessage(e);
        if (
            msg.includes("Debugger is not attached") ||
            msg.includes("No tab with id") ||
            msg.includes("Target closed") ||
            msg.includes("Session with given id not found")
        ) {
            return;
        }
        console.error("[browsercontrol] visual feedback command failed:", msg);
    }
}

/** Evaluates an expression on the page and returns the parsed value. */
export async function evalOnPageWithResult<T = unknown>(
    target: chrome.debugger.Debuggee,
    expression: string,
    awaitPromise = false,
): Promise<T | undefined> {
    try {
        const evalResult = await sendCommand(target, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        });
        if (evalResult?.exceptionDetails) {
            console.error(
                "[browsercontrol] evalOnPage script threw:",
                evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails.text,
            );
            return undefined;
        }
        return evalResult?.result?.value as T | undefined;
    } catch (e) {
        console.error("[browsercontrol] evalOnPage command failed:", errorMessage(e));
        return undefined;
    }
}

// Every chrome.debugger.sendCommand call used to be hand-wrapped in
// `new Promise((resolve) => chrome.debugger.sendCommand(...))` with the
// result typed `any` — @types/chrome has no way to link a CDP method string
// to its actual response shape. This wrapper does that linkage manually via
// an explicit type parameter backed by devtools-protocol's Protocol
// namespace (the same source of truth Chrome's own DevTools frontend is
// generated from), and folds the repeated Promise-wrapping into one place.

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";

export function sendCommand<M extends keyof ProtocolMapping.Commands>(
    target: chrome.debugger.Debuggee,
    method: M,
    params?: ProtocolMapping.Commands[M]["paramsType"][0],
): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, method, params ?? {}, (result) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`CDP ${method} failed: ${err.message}`));
            else resolve(result as ProtocolMapping.Commands[M]["returnType"]);
        });
    });
}

export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

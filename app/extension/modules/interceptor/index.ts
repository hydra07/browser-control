import type { Protocol } from "devtools-protocol";
import { sendCommand } from "../../libs/cdp.js";
import { findRecordedResponse } from "../network/index.js";
import { MAX_BLOCKED, MUTATING_METHODS } from "./constants.js";
import type { BlockedRequest } from "./types.js";

export type { BlockedRequest } from "./types.js";

function toBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/**
 * Sandbox mode interceptor: pauses and mock-fulfills mutating HTTP requests (POST/PUT/DELETE) via CDP Fetch domain.
 */
export class RequestInterceptor {
    public readonly blockedRequestIds: Set<string>;
    private readonly sandboxedTabs: Set<number>;
    private readonly blockedLog: BlockedRequest[];
    private listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | null;

    constructor() {
        this.blockedRequestIds = new Set();
        this.sandboxedTabs = new Set();
        this.blockedLog = [];
        this.listener = null;
    }

    private async handlePaused(target: chrome.debugger.Debuggee, p: Protocol.Fetch.RequestPausedEvent): Promise<void> {
        const { requestId, request } = p;
        const method = request.method.toUpperCase();

        if (!MUTATING_METHODS.has(method)) {
            await sendCommand(target, "Fetch.continueRequest", { requestId }).catch(() => {});
            return;
        }

        this.blockedRequestIds.add(requestId);

        const recorded = await findRecordedResponse(target, method, request.url).catch(() => undefined);
        const responseCode = recorded?.status ?? 200;
        const mimeType = recorded?.mimeType ?? "application/json";
        let body = recorded?.body;
        if (body === undefined) {
            body = "{}";
            if (request.postData) {
                try {
                    JSON.parse(request.postData);
                    body = request.postData;
                } catch {
                    // Fall back to empty JSON on non-JSON payload
                }
            }
        }

        this.blockedLog.push({
            requestId,
            method,
            url: request.url,
            postData: request.postData,
            timestamp: Date.now(),
            mockSource: recorded ? "recorded" : "echo",
        });
        if (this.blockedLog.length > MAX_BLOCKED) {
            this.blockedLog.splice(0, this.blockedLog.length - MAX_BLOCKED);
        }

        await sendCommand(target, "Fetch.fulfillRequest", {
            requestId,
            responseCode,
            responseHeaders: [{ name: "content-type", value: mimeType }],
            body: toBase64(body),
        }).catch(() => {});
    }

    public install(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
        }
        this.listener = (source, method, params) => {
            if (method !== "Fetch.requestPaused") return;
            if (source.tabId == null || !this.sandboxedTabs.has(source.tabId)) return;
            void this.handlePaused(source as chrome.debugger.Debuggee, params as Protocol.Fetch.RequestPausedEvent);
        };
        chrome.debugger.onEvent.addListener(this.listener);
    }

    public async setSandbox(target: chrome.debugger.Debuggee, tabId: number, enabled: boolean): Promise<void> {
        if (enabled) {
            this.sandboxedTabs.add(tabId);
            await sendCommand(target, "Fetch.enable", { patterns: [{ requestStage: "Request" }] });
        } else {
            this.sandboxedTabs.delete(tabId);
            await sendCommand(target, "Fetch.disable").catch(() => {});
        }
    }

    public isSandboxed(tabId: number): boolean {
        return this.sandboxedTabs.has(tabId);
    }

    public forgetTab(tabId: number): void {
        this.sandboxedTabs.delete(tabId);
    }

    public listBlockedRequests(limit = 20): BlockedRequest[] {
        return this.blockedLog.slice(-limit);
    }

    public clear(): void {
        this.blockedLog.length = 0;
        this.blockedRequestIds.clear();
    }

    public dispose(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
            this.listener = null;
        }
        this.blockedLog.length = 0;
        this.blockedRequestIds.clear();
        this.sandboxedTabs.clear();
    }
}

export const requestInterceptor = new RequestInterceptor();
export const blockedRequestIds = requestInterceptor.blockedRequestIds;

export function installInterceptor(): void {
    requestInterceptor.install();
}

export function setSandbox(target: chrome.debugger.Debuggee, tabId: number, enabled: boolean): Promise<void> {
    return requestInterceptor.setSandbox(target, tabId, enabled);
}

export function isSandboxed(tabId: number): boolean {
    return requestInterceptor.isSandboxed(tabId);
}

export function forgetTab(tabId: number): void {
    requestInterceptor.forgetTab(tabId);
}

export function listBlockedRequests(limit = 20): BlockedRequest[] {
    return requestInterceptor.listBlockedRequests(limit);
}

export function clearBlockedRequests(): void {
    requestInterceptor.clear();
}

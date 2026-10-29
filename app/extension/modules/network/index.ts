/**
 * Passive network request collector via CDP Network events, buffering entries in memory.
 */
import type { Protocol } from "devtools-protocol";
import { sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { blockedRequestIds } from "../interceptor/index.js";
import { DEFAULT_RESOURCE_TYPES, MAX_BODY_CHARS, MAX_ENTRIES } from "./constants.js";
import type { NetworkEntry } from "./types.js";

export type { NetworkEntry } from "./types.js";

export function redactNetworkUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.username) url.username = "REDACTED";
        if (url.password) url.password = "REDACTED";
        for (const key of url.searchParams.keys())
            if (/token|secret|password|passcode|api[-_]?key|authorization|credential/i.test(key))
                url.searchParams.set(key, "REDACTED");
        return url.href;
    } catch {
        return redactBody(value);
    }
}

function redactBody(value: string): string {
    return value
        .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
        .replace(
            /((?:["']?(?:password|passcode|pin|token|secret|api[_-]?key|authorization|cookie)["']?)\s*[=:]\s*["']?)[^"'&\s,;}]*/gi,
            "$1[REDACTED]",
        );
}

export class NetworkCollector {
    private readonly entries: Map<string, NetworkEntry>;
    private listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | null;

    constructor() {
        this.entries = new Map();
        this.listener = null;
    }

    private evictIfNeeded(): void {
        while (this.entries.size > MAX_ENTRIES) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) break;
            this.entries.delete(oldestKey);
        }
    }

    public install(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
        }
        this.listener = (source, method, params) => {
            if (!source.tabId) return;
            const tabId = source.tabId;

            switch (method) {
                case "Network.requestWillBeSent": {
                    const p = params as Protocol.Network.RequestWillBeSentEvent;
                    this.entries.set(`${tabId}:${p.requestId}`, {
                        tabId,
                        requestId: p.requestId,
                        url: p.request.url,
                        method: p.request.method,
                        resourceType: p.type ?? "Other",
                        // Headers and request bodies are intentionally not retained by default.
                        timestamp: Date.now(),
                    });
                    this.evictIfNeeded();
                    break;
                }
                case "Network.responseReceived": {
                    const p = params as Protocol.Network.ResponseReceivedEvent;
                    const entry = this.entries.get(`${tabId}:${p.requestId}`);
                    if (entry) {
                        entry.status = p.response.status;
                        entry.statusText = p.response.statusText;
                        entry.mimeType = p.response.mimeType;
                    }
                    break;
                }
                case "Network.loadingFailed": {
                    const p = params as Protocol.Network.LoadingFailedEvent;
                    const entry = this.entries.get(`${tabId}:${p.requestId}`);
                    if (entry) {
                        entry.failed = true;
                        entry.errorText = p.errorText;
                        entry.durationMs = Date.now() - entry.timestamp;
                    }
                    break;
                }
                case "Network.loadingFinished": {
                    const p = params as Protocol.Network.LoadingFinishedEvent;
                    const entry = this.entries.get(`${tabId}:${p.requestId}`);
                    if (entry) {
                        entry.sizeBytes = p.encodedDataLength;
                        entry.durationMs = Date.now() - entry.timestamp;
                    }
                    break;
                }
            }
        };
        chrome.debugger.onEvent.addListener(this.listener);
    }

    public clear(tabId?: number): void {
        if (tabId === undefined) this.entries.clear();
        else for (const [key, entry] of this.entries) if (entry.tabId === tabId) this.entries.delete(key);
    }

    public size(): number {
        return this.entries.size;
    }

    public dispose(): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
            this.listener = null;
        }
        this.entries.clear();
    }

    public list(
        opts: { tabId?: number; resourceTypes?: string[]; filter?: string; limit?: number } = {},
    ): Array<Partial<NetworkEntry>> {
        const limit = opts.limit ?? 15;
        const allowed =
            opts.resourceTypes && opts.resourceTypes.length > 0 ? new Set(opts.resourceTypes) : DEFAULT_RESOURCE_TYPES;

        return Array.from(this.entries.values())
            .filter((e) => opts.tabId === undefined || e.tabId === opts.tabId)
            .filter((e) => allowed.has(e.resourceType))
            .filter((e) => !opts.filter || e.url.includes(opts.filter))
            .slice(-limit)
            .map((e) => ({
                tabId: e.tabId,
                timestamp: e.timestamp,
                requestId: e.requestId,
                method: e.method,
                url: redactNetworkUrl(e.url),
                status: e.status,
                resourceType: e.resourceType,
                mimeType: e.mimeType,
                sizeBytes: e.sizeBytes,
                durationMs: e.durationMs,
                failed: e.failed,
                errorText: e.errorText,
                blocked: blockedRequestIds.has(`${e.tabId}:${e.requestId}`) || undefined,
            }));
    }

    /** Finds a previously recorded HTTP response matching method and URL to mock sandbox requests. */
    public async findRecordedResponse(
        target: chrome.debugger.Debuggee,
        method: string,
        url: string,
    ): Promise<{ status: number; mimeType?: string; body: string } | undefined> {
        const candidates = Array.from(this.entries.values())
            .filter(
                (e) =>
                    e.tabId === target.tabId &&
                    e.method === method &&
                    e.url === url &&
                    e.status !== undefined &&
                    !blockedRequestIds.has(`${e.tabId}:${e.requestId}`),
            )
            .sort((a, b) => b.timestamp - a.timestamp);

        for (const entry of candidates) {
            try {
                const res = await sendCommand(target, "Network.getResponseBody", { requestId: entry.requestId });
                if (res?.body !== undefined && !res.base64Encoded) {
                    return { status: entry.status!, mimeType: entry.mimeType, body: res.body };
                }
            } catch {
                // Evicted from Chrome cache
            }
        }
        return undefined;
    }

    public async getDetail(
        target: chrome.debugger.Debuggee,
        requestId: string,
        includeBody = false,
    ): Promise<Record<string, unknown>> {
        const entry = this.entries.get(`${target.tabId}:${requestId}`);
        if (!entry) {
            return {
                error: "Unknown requestId",
                hint: "Call `browsercontrol net list` again — the buffer may have rotated it out, or it belongs to a request from before the last navigate/network_clear.",
            };
        }

        if (!includeBody) {
            return {
                requestId: entry.requestId,
                url: redactNetworkUrl(entry.url),
                method: entry.method,
                resourceType: entry.resourceType,
                status: entry.status,
                statusText: entry.statusText,
                mimeType: entry.mimeType,
                failed: entry.failed,
                errorText: entry.errorText,
                timestamp: entry.timestamp,
                sizeBytes: entry.sizeBytes,
                durationMs: entry.durationMs,
                blocked: blockedRequestIds.has(`${entry.tabId}:${requestId}`) || undefined,
                bodyUnavailable:
                    "Body capture is disabled by default; request it explicitly from a dev-only operation.",
            };
        }

        let bodyResult: Protocol.Network.GetResponseBodyResponse | undefined;
        let bodyError: string | undefined;
        try {
            bodyResult = await sendCommand(target, "Network.getResponseBody", { requestId });
        } catch (e) {
            bodyError = errorMessage(e);
        }

        let requestPostData: string | undefined;
        try {
            const requestBodyResult = await sendCommand(target, "Network.getRequestPostData", { requestId });
            if (typeof requestBodyResult?.postData === "string")
                requestPostData = redactBody(requestBodyResult.postData);
        } catch {
            // Request post data can be unavailable after the request has completed.
        }

        let body: string | undefined = bodyResult?.base64Encoded
            ? undefined
            : typeof bodyResult?.body === "string"
              ? redactBody(bodyResult.body)
              : undefined;
        let bodyTruncated = false;
        if (typeof body === "string" && body.length > MAX_BODY_CHARS) {
            body = body.slice(0, MAX_BODY_CHARS);
            bodyTruncated = true;
        }

        return {
            ...entry,
            url: redactNetworkUrl(entry.url),
            blocked: blockedRequestIds.has(`${entry.tabId}:${requestId}`) || undefined,
            body,
            bodyBase64Encoded: bodyResult?.base64Encoded,
            postData: requestPostData,
            bodyTruncated,
            bodyUnavailable:
                bodyResult?.body === undefined
                    ? (bodyError ?? "Body not available (non-text response, or evicted by Chrome).")
                    : undefined,
        };
    }
}

export const networkCollector = new NetworkCollector();

export function installNetworkCollector(): void {
    networkCollector.install();
}

export function clearNetworkRequests(tabId?: number): void {
    networkCollector.clear(tabId);
}

export function listNetworkRequests(opts?: {
    tabId?: number;
    resourceTypes?: string[];
    filter?: string;
    limit?: number;
}): Array<Partial<NetworkEntry>> {
    return networkCollector.list(opts);
}

export function findRecordedResponse(
    target: chrome.debugger.Debuggee,
    method: string,
    url: string,
): Promise<{ status: number; mimeType?: string; body: string } | undefined> {
    return networkCollector.findRecordedResponse(target, method, url);
}

export function getNetworkRequestDetail(
    target: chrome.debugger.Debuggee,
    requestId: string,
    includeBody = false,
): Promise<Record<string, unknown>> {
    return networkCollector.getDetail(target, requestId, includeBody);
}

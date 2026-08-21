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

    public install(getActiveTabId: () => number | null): void {
        if (this.listener) {
            chrome.debugger.onEvent.removeListener(this.listener);
        }
        this.listener = (source, method, params) => {
            if (!source.tabId || source.tabId !== getActiveTabId()) return;

            switch (method) {
                case "Network.requestWillBeSent": {
                    const p = params as Protocol.Network.RequestWillBeSentEvent;
                    this.entries.set(p.requestId, {
                        requestId: p.requestId,
                        url: p.request.url,
                        method: p.request.method,
                        resourceType: p.type ?? "Other",
                        requestHeaders: p.request.headers,
                        postData: p.request.postData,
                        timestamp: Date.now(),
                    });
                    this.evictIfNeeded();
                    break;
                }
                case "Network.responseReceived": {
                    const p = params as Protocol.Network.ResponseReceivedEvent;
                    const entry = this.entries.get(p.requestId);
                    if (entry) {
                        entry.status = p.response.status;
                        entry.statusText = p.response.statusText;
                        entry.mimeType = p.response.mimeType;
                        entry.responseHeaders = p.response.headers;
                    }
                    break;
                }
                case "Network.loadingFailed": {
                    const p = params as Protocol.Network.LoadingFailedEvent;
                    const entry = this.entries.get(p.requestId);
                    if (entry) {
                        entry.failed = true;
                        entry.errorText = p.errorText;
                        entry.durationMs = Date.now() - entry.timestamp;
                    }
                    break;
                }
                case "Network.loadingFinished": {
                    const p = params as Protocol.Network.LoadingFinishedEvent;
                    const entry = this.entries.get(p.requestId);
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

    public clear(): void {
        this.entries.clear();
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
        opts: { resourceTypes?: string[]; filter?: string; limit?: number } = {},
    ): Array<Partial<NetworkEntry>> {
        const limit = opts.limit ?? 15;
        const allowed =
            opts.resourceTypes && opts.resourceTypes.length > 0 ? new Set(opts.resourceTypes) : DEFAULT_RESOURCE_TYPES;

        return Array.from(this.entries.values())
            .filter((e) => allowed.has(e.resourceType))
            .filter((e) => !opts.filter || e.url.includes(opts.filter))
            .slice(-limit)
            .map((e) => ({
                requestId: e.requestId,
                method: e.method,
                url: e.url,
                status: e.status,
                resourceType: e.resourceType,
                mimeType: e.mimeType,
                sizeBytes: e.sizeBytes,
                durationMs: e.durationMs,
                failed: e.failed,
                errorText: e.errorText,
                blocked: blockedRequestIds.has(e.requestId) || undefined,
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
                    e.method === method &&
                    e.url === url &&
                    e.status !== undefined &&
                    !blockedRequestIds.has(e.requestId),
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

    public async getDetail(target: chrome.debugger.Debuggee, requestId: string): Promise<Record<string, unknown>> {
        const entry = this.entries.get(requestId);
        if (!entry) {
            return {
                error: "Unknown requestId",
                hint: 'Call browser_inspect({action:"network_requests"}) again — the buffer may have rotated it out, or it belongs to a request from before the last navigate/network_clear.',
            };
        }

        let bodyResult: Protocol.Network.GetResponseBodyResponse | undefined;
        let bodyError: string | undefined;
        try {
            bodyResult = await sendCommand(target, "Network.getResponseBody", {
                requestId,
            });
        } catch (e) {
            bodyError = errorMessage(e);
        }

        let body: string | undefined = bodyResult?.body;
        let bodyTruncated = false;
        if (typeof body === "string" && body.length > MAX_BODY_CHARS) {
            body = body.slice(0, MAX_BODY_CHARS);
            bodyTruncated = true;
        }

        return {
            ...entry,
            blocked: blockedRequestIds.has(requestId) || undefined,
            body,
            bodyBase64Encoded: bodyResult?.base64Encoded,
            bodyTruncated,
            bodyUnavailable:
                bodyResult?.body === undefined
                    ? (bodyError ?? "Body not available (non-text response, or evicted by Chrome).")
                    : undefined,
        };
    }
}

export const networkCollector = new NetworkCollector();

export function installNetworkCollector(getActiveTabId: () => number | null): void {
    networkCollector.install(getActiveTabId);
}

export function clearNetworkRequests(): void {
    networkCollector.clear();
}

export function listNetworkRequests(opts?: {
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
): Promise<Record<string, unknown>> {
    return networkCollector.getDetail(target, requestId);
}

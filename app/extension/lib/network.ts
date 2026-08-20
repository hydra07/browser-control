import type { Protocol } from "devtools-protocol";
import { sendCommand, errorMessage } from "./cdp.js";

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  failed?: boolean;
  errorText?: string;
  timestamp: number;
  sizeBytes?: number;
  durationMs?: number;
}

// XHR/Fetch/Document/WebSocket are what an action button actually triggers.
// Everything else (images, css, fonts, scripts) is page-load noise that would
// otherwise drown out the one API call the agent is looking for.
const DEFAULT_RESOURCE_TYPES = new Set([
  "XHR",
  "Fetch",
  "Document",
  "WebSocket",
  "EventSource",
]);
const MAX_ENTRIES = 300;
const MAX_BODY_CHARS = 20000;

const entries = new Map<string, NetworkEntry>();

function evictIfNeeded(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

export function installNetworkCollector(
  getActiveTabId: () => number | null,
): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source.tabId || source.tabId !== getActiveTabId()) return;

    if (method === "Network.requestWillBeSent") {
      const p = params as Protocol.Network.RequestWillBeSentEvent;
      entries.set(p.requestId, {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        resourceType: p.type ?? "Other",
        requestHeaders: p.request.headers,
        postData: p.request.postData,
        timestamp: Date.now(),
      });
      evictIfNeeded();
    } else if (method === "Network.responseReceived") {
      const p = params as Protocol.Network.ResponseReceivedEvent;
      const entry = entries.get(p.requestId);
      if (entry) {
        entry.status = p.response.status;
        entry.statusText = p.response.statusText;
        entry.mimeType = p.response.mimeType;
        entry.responseHeaders = p.response.headers;
      }
    } else if (method === "Network.loadingFailed") {
      const p = params as Protocol.Network.LoadingFailedEvent;
      const entry = entries.get(p.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = p.errorText;
        entry.durationMs = Date.now() - entry.timestamp;
      }
    } else if (method === "Network.loadingFinished") {
      const p = params as Protocol.Network.LoadingFinishedEvent;
      const entry = entries.get(p.requestId);
      if (entry) {
        entry.sizeBytes = p.encodedDataLength;
        entry.durationMs = Date.now() - entry.timestamp;
      }
    }
  });
}

export function clearNetworkRequests(): void {
  entries.clear();
}

export function listNetworkRequests(
  opts: { resourceTypes?: string[]; filter?: string; limit?: number } = {},
): Array<Partial<NetworkEntry>> {
  const limit = opts.limit ?? 50;
  const allowed =
    opts.resourceTypes && opts.resourceTypes.length > 0
      ? new Set(opts.resourceTypes)
      : DEFAULT_RESOURCE_TYPES;

  return Array.from(entries.values())
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
    }));
}

export async function getNetworkRequestDetail(
  target: chrome.debugger.Debuggee,
  requestId: string,
): Promise<Record<string, unknown>> {
  const entry = entries.get(requestId);
  if (!entry) {
    return {
      error: "Unknown requestId",
      hint: "Call browser_inspect({action:\"network_requests\"}) again — the buffer may have rotated it out, or it belongs to a request from before the last navigate/network_clear.",
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
    body,
    bodyBase64Encoded: bodyResult?.base64Encoded,
    bodyTruncated,
    bodyUnavailable:
      bodyResult?.body === undefined
        ? (bodyError ??
          "Body not available (non-text response, or evicted by Chrome).")
        : undefined,
  };
}

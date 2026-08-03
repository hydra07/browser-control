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
const DEFAULT_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'Document', 'WebSocket', 'EventSource']);
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

export function installNetworkCollector(getActiveTabId: () => number | null): void {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (!source.tabId || source.tabId !== getActiveTabId()) return;

    if (method === 'Network.requestWillBeSent') {
      entries.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type ?? 'Other',
        requestHeaders: params.request.headers,
        postData: params.request.postData,
        timestamp: Date.now(),
      });
      evictIfNeeded();
    } else if (method === 'Network.responseReceived') {
      const entry = entries.get(params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.statusText = params.response.statusText;
        entry.mimeType = params.response.mimeType;
        entry.responseHeaders = params.response.headers;
      }
    } else if (method === 'Network.loadingFailed') {
      const entry = entries.get(params.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = params.errorText;
        entry.durationMs = Date.now() - entry.timestamp;
      }
    } else if (method === 'Network.loadingFinished') {
      const entry = entries.get(params.requestId);
      if (entry) {
        entry.sizeBytes = params.encodedDataLength;
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
  const allowed = opts.resourceTypes && opts.resourceTypes.length > 0
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
): Promise<any> {
  const entry = entries.get(requestId);
  if (!entry) {
    return { error: 'Unknown requestId', hint: 'Call browser_network_requests again — the buffer may have rotated it out, or it belongs to a request from before the last navigate/network_clear.' };
  }

  const bodyResult: any = await new Promise((resolve) => {
    chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId }, resolve);
  });

  let body: string | undefined = bodyResult?.body;
  let bodyTruncated = false;
  if (typeof body === 'string' && body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    bodyTruncated = true;
  }

  return {
    ...entry,
    body,
    bodyBase64Encoded: bodyResult?.base64Encoded,
    bodyTruncated,
    bodyUnavailable: bodyResult?.body === undefined
      ? (bodyResult?.error?.message ?? 'Body not available (non-text response, or evicted by Chrome).')
      : undefined,
  };
}

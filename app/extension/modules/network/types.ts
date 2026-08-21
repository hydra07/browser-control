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
    // Sandbox mode (modules/interceptor) fulfilled this one itself — it
    // never reached the real backend, whatever status/body shows here is
    // the mock.
    blocked?: boolean;
}

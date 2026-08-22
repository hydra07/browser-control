export interface FrameMessage {
    data: string;
    metadata: { deviceWidth: number; deviceHeight: number };
}
export type PortAck = { success: true; tabId: number } | { error: string; hint: string };

export interface CaptureAck {
    [key: string]: unknown;
    success: true;
    message: string;
    tabId: number;
    width: number;
    height: number;
    mimeType: string;
}

export interface CaptureResult {
    [key: string]: unknown;
    success: true;
    format: "webm";
    dataBase64?: string;
    isStreamed?: boolean;
    durationMs: number;
    frameCount: number;
    width: number;
    height: number;
    mimeType: string;
}

export interface CaptureError {
    [key: string]: unknown;
    error: string;
    hint: string;
}

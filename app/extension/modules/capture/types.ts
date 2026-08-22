export interface FrameMessage {
    data: string;
    metadata: { deviceWidth: number; deviceHeight: number };
}
export type PortAck = { success: true } | { error: string; hint: string };

export interface CaptureAck {
    [key: string]: unknown;
    success: true;
    message: string;
}

export interface CaptureResult {
    [key: string]: unknown;
    success: true;
    format: "webm";
    dataBase64?: string;
    isStreamed?: boolean;
    durationMs: number;
    frameCount: number;
}

export interface CaptureError {
    [key: string]: unknown;
    error: string;
    hint: string;
}

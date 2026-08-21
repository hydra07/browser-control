// Index signatures so these slot straight into the extension's
// Record<string, unknown> command-result type without a cast at each call
// site.
export interface ScreenshotResult {
    [key: string]: unknown;
    success: true;
    format: "jpeg" | "png";
    dataBase64: string;
}

export interface AnnotatedScreenshotResult {
    [key: string]: unknown;
    format: "jpeg";
    dataBase64: string;
}

export interface ScreenshotError {
    [key: string]: unknown;
    error: string;
    hint: string;
}

// Index signatures so these slot straight into the extension's
// Record<string, unknown> command-result type without a cast at each call
// site.
export type ScreenshotFormat = "jpeg" | "png" | "webp";

export type CaptureMode = "viewport" | "full" | "scroll-container" | "element" | "clip";

export interface ScreenshotOptions {
    format?: ScreenshotFormat;
    quality?: number;
    fullPage?: boolean;
    /** Capture one element (backend node id), scrolled into view, plus `padding` CSS px around it. */
    nodeId?: number;
    /** Capture a rectangle given in viewport CSS px (the coordinate space snapshot/visual boxes use). */
    clip?: { x: number; y: number; width: number; height: number };
    padding?: number;
    /** Output pixels per CSS pixel; 1 = CSS size regardless of devicePixelRatio, 2-3 to zoom into small regions. */
    zoom?: number;
    /** Longest output edge in pixels; taller full-page captures are cut and reported as truncated. */
    maxDimension?: number;
}

export interface ScreenshotResult {
    [key: string]: unknown;
    success: true;
    format: ScreenshotFormat;
    mode: CaptureMode;
    /** Captured area in CSS px; the image is width*zoom × height*zoom. */
    width: number;
    height: number;
    zoom: number;
    truncated?: boolean;
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

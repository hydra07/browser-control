/** Longest output edge; well under Chrome's ~16k-px capture texture limit. */
export const DEFAULT_MAX_DIMENSION = 12000;
/** CSS px of context kept around an element capture. */
export const DEFAULT_ELEMENT_PADDING = 8;
/** Element/clip captures without an explicit zoom are magnified toward this long-edge size... */
export const AUTO_ZOOM_TARGET_PX = 900;
/** ...but never more than this. */
export const MAX_AUTO_ZOOM = 3;
export const MAX_ZOOM = 4;
/** Chunks for inner-scroll-container stitching (each one viewport of the container). */
export const MAX_STITCH_STEPS = 40;
/** captureVisibleTab is quota-limited to 2 calls/second per extension; stay just under it. */
export const VISIBLE_CAPTURE_INTERVAL_MS = 550;

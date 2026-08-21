import pkg from "../../package.json" with { type: "json" };

/** Loopback only, matches the extension's hardcoded daemon URL — Bun's `serve` defaults to all interfaces otherwise. */
export const PORT = 8765;
export const HOSTNAME = "127.0.0.1";

/** @browsercontrol/server's own version, versioned independently from the extension's manifest.json. */
export const PACKAGE_VERSION = pkg.version ?? "0.0.0";

/**
 * Some MCP clients (older Antigravity CLI builds) can't render inline image
 * content — a mishandled screenshot then lands in context as raw base64
 * (~230k tokens for a ~700KB PNG). Default to file-only.
 */
export const INLINE_IMAGES = process.env.BROWSERCONTROL_INLINE_IMAGES === "true";

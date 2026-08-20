// Small shared types used across daemon.ts and its tool-schema/handler
// modules — kept separate so toolHandlers.ts and toolSchemas.ts don't need
// to import daemon.ts (which owns the WebSocket/HTTP server) just for types.

/** Raw MCP tool-call arguments. Never schema-validated beyond what the SDK already does, so `unknown` values rather than a typed union. */
export type ToolArgs = Record<string, unknown> | undefined;

/** executeCommand's return — shape depends on `cmd` (see background.ts's dispatchCommand), so callers narrow with optional chaining instead of this being `any`. */
export type CommandResult = Record<string, unknown>;

export type ToolCallResponse = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

// daemon.ts's executeCommand signature is `Executor`, defined in jobs.ts
// (crawl.ts already imports it from there) — reuse that one instead of a
// second type for the same shape.

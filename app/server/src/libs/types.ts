/**
 * Small shared types used across daemon.ts and 2+ modules — kept here
 * instead of in one module's own types.ts so no module has to import
 * another just to reuse a shape (see AGENTS.md's module-ownership rule).
 */

/** Raw MCP tool-call arguments. Never schema-validated beyond what the SDK already does, so `unknown` values rather than a typed union. */
export type ToolArgs = Record<string, unknown> | undefined;

/** executeCommand's return — shape depends on `cmd` (see background.ts's dispatchCommand), so callers narrow with optional chaining instead of this being `any`. */
export type CommandResult = Record<string, unknown>;

/** MCP tool-call result shape returned to the client. */
export type ToolCallResponse = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

/** Whatever moves a command from daemon.ts to the extension and back — passed into modules that need it rather than imported, so they don't have to import daemon.ts (which imports them). */
export type Executor = (
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

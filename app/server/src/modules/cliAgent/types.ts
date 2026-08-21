export interface AgentQueryParams {
  prompt: string;
  url?: string;
  title?: string;
  selectionText?: string;
  compactContext?: string;
  customCommand?: string;
  timeoutMs?: number;
  /** Resume the given `claude` session instead of starting a fresh one (multi-turn continuity + prompt caching). */
  sessionId?: string;
}

export interface AgentQueryResult {
  success: boolean;
  content: string;
  commandUsed: string;
  durationMs: number;
  error?: string;
  sessionId?: string;
}

export type ClaudeStreamEvent = { type: string; content_block?: { type: string; id?: string; name?: string } };

export type ClaudeStreamLine =
  | { type: "system"; subtype?: string; session_id?: string }
  | { type: "stream_event"; event: ClaudeStreamEvent }
  | { type: "user"; message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> } }
  | { type: "result"; subtype?: string; is_error?: boolean; result?: string; session_id?: string }
  | { type: string; [k: string]: unknown };

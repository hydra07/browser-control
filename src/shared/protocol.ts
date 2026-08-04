// The wire contract between src/server (daemon.ts, which constructs these)
// and src/extension (background.ts, which executes them) — the only
// intentionally-shared surface between the two runtimes. Type-only: nothing
// here has a runtime body, so importing it via `import type` pulls zero
// code across the extension/server boundary, keeping them genuinely
// separate processes that just happen to agree on a message shape.

export type BrowserCommand =
  | { cmd: 'navigate'; url: string }
  | { cmd: 'snapshot' }
  | { cmd: 'query_region'; selector: string }
  | { cmd: 'visual_snapshot' }
  | { cmd: 'click'; nodeId: number }
  | { cmd: 'type'; text: string; nodeId?: number }
  | { cmd: 'scroll'; deltaX?: number; deltaY?: number }
  | { cmd: 'screenshot'; fullPage?: boolean; format?: 'jpeg' | 'png'; quality?: number }
  | { cmd: 'network_requests'; resourceTypes?: string[]; filter?: string; limit?: number }
  | { cmd: 'network_request_detail'; requestId: string }
  | { cmd: 'network_clear' }
  | { cmd: 'inspect_element'; nodeId: number }
  | { cmd: 'evaluate'; expression: string };

// What background.ts sends back over the WebSocket for every request,
// success or failure — the shape daemon.ts's /execute and executeCommand()
// both parse.
export interface ExtensionResponse {
  id: string;
  type: 'result' | 'error';
  data?: unknown;
  error?: string;
}

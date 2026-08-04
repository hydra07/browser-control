// The wire contract between src/server (daemon.ts, which constructs these)
// and src/extension (background.ts, which executes them) — the only
// intentionally-shared surface between the two runtimes. Type-only: nothing
// here has a runtime body, so importing it via `import type` pulls zero
// code across the extension/server boundary, keeping them genuinely
// separate processes that just happen to agree on a message shape.

// One step in a run_flow/explore_flow script. Elements are referenced by
// role+name (matching browser_snapshot's {i,r,n,v} identity, resolved fresh
// against the live page at execution time — never a pre-known nodeId, since
// a script is written before the steps that create later DOM state have
// run) or by CSS selector, not by a nodeId the AI can't know in advance.
export interface FlowStep {
  action: 'click' | 'type' | 'press_key' | 'wait_for' | 'assert_text' | 'scroll';
  role?: string;
  name?: string;
  selector?: string;
  text?: string;
  key?: string;
  contains?: string;
  deltaX?: number;
  deltaY?: number;
  timeoutMs?: number;
  // Opt-in override to proceed past a step whose target looks destructive/
  // irreversible (see isRiskyTarget in background.ts) — set only after the
  // calling AI has confirmed with its own user that this step is intended.
  confirmRisky?: boolean;
}

export type BrowserCommand =
  | { cmd: 'navigate'; url: string }
  | { cmd: 'snapshot' }
  | { cmd: 'query_region'; selector: string }
  | { cmd: 'visual_snapshot' }
  | { cmd: 'click'; nodeId: number }
  | { cmd: 'type'; text: string; nodeId?: number }
  | { cmd: 'press_key'; key: string; nodeId?: number }
  | { cmd: 'scroll'; deltaX?: number; deltaY?: number }
  | { cmd: 'screenshot'; fullPage?: boolean; format?: 'jpeg' | 'png'; quality?: number }
  | { cmd: 'network_requests'; resourceTypes?: string[]; filter?: string; limit?: number }
  | { cmd: 'network_request_detail'; requestId: string }
  | { cmd: 'network_clear' }
  | { cmd: 'inspect_element'; nodeId: number }
  | { cmd: 'evaluate'; expression: string }
  | { cmd: 'run_flow'; steps: FlowStep[] }
  | { cmd: 'explore_flow'; steps: FlowStep[] };

// What background.ts sends back over the WebSocket for every request,
// success or failure — the shape daemon.ts's /execute and executeCommand()
// both parse.
export interface ExtensionResponse {
  id: string;
  type: 'result' | 'error';
  data?: unknown;
  error?: string;
}

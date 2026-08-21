// The wire contract between src/server (constructs these) and
// src/extension (executes them). Type-only — `import type` pulls zero
// runtime code across the extension/server boundary.

// One step in a run_flow/explore_flow script. Elements are referenced by
// role+name (resolved fresh against the live page at execution time, since
// a script is written before the steps that create later DOM state run) or
// by CSS selector — never a pre-known nodeId.
export interface FlowStep {
    action: "click" | "type" | "press_key" | "wait_for" | "assert_text" | "scroll" | "drag";
    role?: string;
    name?: string;
    selector?: string;
    text?: string;
    key?: string;
    contains?: string;
    deltaX?: number;
    deltaY?: number;
    // action: 'drag' — supports raw coordinates, geometric shapes, and multi-point paths
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
    shape?:
        | "straight"
        | "circle"
        | "arc"
        | "ellipse"
        | "bezier"
        | "sine"
        | "zigzag"
        | "spiral"
        | "waypoints"
        | "polygon"
        | "star"
        | "heart"
        | "flower"
        | "rectangle"
        | "box"
        | "parametric"
        | "polar"
        | "function";
    shapeParams?: Record<string, unknown>;
    path?: Array<{ x: number; y: number } | [number, number]>;
    stepsCount?: number;
    easing?: "linear" | "easeIn" | "easeOut" | "easeInOut";
    button?: "left" | "right" | "middle";
    timeoutMs?: number;
    // Proceed past a step whose target looks destructive/irreversible (see
    // isRiskyTarget in actions.ts) — only after the calling AI confirmed with
    // its own user that this step is intended.
    confirmRisky?: boolean;
}

// `tabId` on every variant: omit it and a command targets whichever tab was
// last navigated/switched to (single-tab behavior); pass it to target a
// specific tab regardless of which one is "current" (background.ts tracks
// CDP-attach state per tab, so several tabs can stay attached at once).
type WithTabId<T> = T & { tabId?: number };

export type BrowserCommand = WithTabId<
    | { cmd: "navigate"; url: string; newTab?: boolean; background?: boolean }
    | { cmd: "snapshot"; compact?: boolean; format?: "compact" | "json" }
    | { cmd: "query_region"; selector: string; compact?: boolean }
    | { cmd: "visual_snapshot" }
    | { cmd: "click"; nodeId: number }
    | { cmd: "type"; text: string; nodeId?: number }
    | { cmd: "press_key"; key: string; nodeId?: number }
    | { cmd: "scroll"; deltaX?: number; deltaY?: number }
    | {
          cmd: "drag";
          fromX?: number;
          fromY?: number;
          toX?: number;
          toY?: number;
          shape?:
              | "straight"
              | "circle"
              | "arc"
              | "ellipse"
              | "bezier"
              | "sine"
              | "zigzag"
              | "spiral"
              | "waypoints"
              | "polygon"
              | "star"
              | "heart"
              | "flower"
              | "rectangle"
              | "box"
              | "parametric"
              | "polar"
              | "function";
          shapeParams?: Record<string, unknown>;
          path?: Array<{ x: number; y: number } | [number, number]>;
          stepsCount?: number;
          easing?: "linear" | "easeIn" | "easeOut" | "easeInOut";
          button?: "left" | "right" | "middle";
      }
    | { cmd: "screenshot"; fullPage?: boolean; format?: "jpeg" | "png"; quality?: number }
    | { cmd: "network_requests"; resourceTypes?: string[]; filter?: string; limit?: number }
    | { cmd: "network_request_detail"; requestId: string }
    | { cmd: "network_clear" }
    | { cmd: "inspect_element"; nodeId: number }
    | { cmd: "evaluate"; expression: string }
    | { cmd: "run_flow"; steps: FlowStep[]; domain?: string; returnSnapshot?: boolean }
    | { cmd: "explore_flow"; steps: FlowStep[]; domain?: string; returnSnapshot?: boolean }
    | { cmd: "list_tabs"; scope?: "workspace" | "all" }
    | { cmd: "switch_tab"; tabId: number }
    | { cmd: "peek_screen"; screenshot?: boolean; maxChars?: number; includeSelection?: boolean }
    | { cmd: "start_capture" }
    | { cmd: "stop_capture" }
    | { cmd: "reading_mode"; maxChars?: number }
    | { cmd: "find"; query: string; limit?: number }
    | { cmd: "select_content"; selector?: string; nodeId?: number; maxChars?: number; maxMatches?: number }
    | { cmd: "batch_crawl"; urls: string[]; concurrency?: number; maxCharsPerUrl?: number }
    | { cmd: "close_tab"; tabId: number }
    | { cmd: "web_search"; query: string; limit?: number }
    | { cmd: "dev_memory"; focus?: "overview" | "dom" | "listeners" | "gc" }
    | { cmd: "dev_process"; focus?: "overview" | "long_tasks" | "rendering" }
    | { cmd: "dev_har"; includeBodies?: boolean; filter?: string }
    | {
          cmd: "dev_layout";
          selector?: string;
          nodeId?: number;
          focus?: "overview" | "box_model" | "computed" | "stacking";
      }
    | {
          cmd: "dev_emulate";
          device?: string;
          network?: "offline" | "slow_3g" | "fast_3g" | "none";
          cpuSlowdown?: number;
          touch?: boolean;
      }
    | { cmd: "dev_sandbox"; mode: "block_mutations" | "off" }
>;

// Optional lightweight runtime telemetry piggybacked onto responses when benchmark mode is active.
export interface ExtensionTelemetry {
    extHeapUsedMb?: number;
    extHeapTotalMb?: number;
    extListenersCount?: number;
    extCacheEntries?: number;
    extDurationMs?: number;
}

// What background.ts sends back over the WebSocket for every request,
// success or failure — the shape daemon.ts's /execute and executeCommand()
// both parse.
export interface ExtensionResponse {
    id: string;
    type: "result" | "error";
    data?: unknown;
    error?: string;
    telemetry?: ExtensionTelemetry;
}

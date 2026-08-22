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
    x?: number;
    y?: number;
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

export interface Point {
    x: number;
    y: number;
}

export type TrajectoryShape =
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

export type EasingType = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface TrajectoryConfig {
    shape?: TrajectoryShape;
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
    start?: Point | [number, number];
    end?: Point | [number, number];
    fnX?: string;
    fnY?: string;
    fnR?: string;
    tMin?: number;
    tMax?: number;
    tRange?: [number, number];
    cx?: number;
    cy?: number;
    radius?: number;
    radiusX?: number;
    radiusY?: number;
    startAngle?: number;
    endAngle?: number;
    clockwise?: boolean;
    control1?: Point | [number, number] | { dx: number; dy: number };
    control2?: Point | [number, number] | { dx: number; dy: number };
    amplitude?: number;
    frequency?: number;
    startRadius?: number;
    endRadius?: number;
    rotations?: number;
    petals?: number;
    numPoints?: number;
    outerRadius?: number;
    innerRadius?: number;
    size?: number;
    width?: number;
    height?: number;
    points?: Array<Point | [number, number]>;
    closed?: boolean;
    steps?: number;
    easing?: EasingType;
    smoothing?: boolean;
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
          points?: Point[];
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
    | { cmd: "start_flow_recording"; tabId?: number; domain?: string }
    | { cmd: "stop_flow_recording" }
    | { cmd: "flow_recording_status" }
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

// ============================================================================
// Binary Framing Protocol (8-Byte Header + Zero-Copy ArrayBuffer Stream)
// Packet: [MAGIC (2B)] [OPCODE (1B)] [FLAGS (1B)] [LENGTH (4B LE)] [RAW BODY]
// ============================================================================

export const BINARY_MAGIC_0 = 0xbc;
export const BINARY_MAGIC_1 = 0x01;
export const BINARY_HEADER_SIZE = 8;

export const BinaryOpcode = {
    SCREENSHOT: 0x01,
    VIDEO_CHUNK: 0x02,
    AXTREE: 0x03,
    HEARTBEAT: 0x04,
} as const;
export type BinaryOpcode = (typeof BinaryOpcode)[keyof typeof BinaryOpcode];

export interface DecodedBinaryPacket {
    opcode: BinaryOpcode;
    flags: number;
    length: number;
    payload: Uint8Array;
}

/** Packs raw payload with an 8-byte Binary Frame Header in zero-copy memory */
export function encodeBinaryPacket(opcode: BinaryOpcode, payload: Uint8Array, flags = 0): Uint8Array {
    const totalSize = BINARY_HEADER_SIZE + payload.byteLength;
    const packet = new Uint8Array(totalSize);
    const view = new DataView(packet.buffer, packet.byteOffset, totalSize);

    // 0..1: Magic bytes 0xBC 0x01
    packet[0] = BINARY_MAGIC_0;
    packet[1] = BINARY_MAGIC_1;
    // 2: Opcode
    packet[2] = opcode;
    // 3: Flags
    packet[3] = flags;
    // 4..7: Length Uint32 LE
    view.setUint32(4, payload.byteLength, true);

    // 8..end: Raw Payload
    packet.set(payload, BINARY_HEADER_SIZE);
    return packet;
}

/** Decodes and validates an incoming Binary Frame Header */
export function decodeBinaryPacket(data: Uint8Array): DecodedBinaryPacket | null {
    if (data.byteLength < BINARY_HEADER_SIZE) return null;
    if (data[0] !== BINARY_MAGIC_0 || data[1] !== BINARY_MAGIC_1) return null;

    const opcode = data[2] as BinaryOpcode;
    const flags = data[3] ?? 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const length = view.getUint32(4, true);

    const payload = data.subarray(BINARY_HEADER_SIZE, BINARY_HEADER_SIZE + length);
    return { opcode, flags, length, payload };
}

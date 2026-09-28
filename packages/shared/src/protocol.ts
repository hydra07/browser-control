// The dependency-light wire contract between server and extension. This file
// also owns the small runtime constants/codecs needed to frame binary packets;
// it must not import application/domain runtime dependencies.

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

export type FlowAction = FlowStep["action"];

export type SettleReason = "load_complete" | "dom_quiet" | "network_quiet" | "condition_met" | "timeout";

export interface DocumentScope {
    documentId: string;
    tabId: number;
    frameId: string;
    loaderId?: string;
}

export interface TargetFingerprint {
    role?: string;
    name?: string;
    testId?: string;
    id?: string;
    href?: string;
    inputType?: string;
    inputName?: string;
    ancestors?: Array<{
        role?: string;
        name?: string;
    }>;
    nearby?: Array<{
        relation: "before" | "after" | "inside" | "label";
        role?: string;
        name?: string;
    }>;
    selectorHints?: string[];
}

export interface FlowTargetDescriptor extends TargetFingerprint {
    recordedRuntimeRef?: string;
    recordedRevision?: string;
}

export interface ExpectedTransition {
    kind: "none" | "navigation" | "text" | "state";
    urlPattern?: string;
    selector?: string;
    contains?: string;
    attribute?: string;
    value?: string;
}

export interface FlowStepPolicy {
    timeoutMs?: number;
    confirmRisky?: boolean;
    onDrift?: "stop" | "repair" | "report";
}

export type DriftKind = "EXACT" | "SEMANTIC_REPAIR" | "TARGET_DRIFT" | "BEHAVIOR_DRIFT";

export type ActionLifecycleEvent =
    | {
          type: "action_started";
          actionId: string;
          ts: number;
          action: FlowAction;
          tabId?: number;
          targetRef?: string;
          semanticTarget?: FlowTargetDescriptor;
          bounds?: { x: number; y: number; width: number; height: number };
          sensitive: boolean;
      }
    | {
          type: "action_finished";
          actionId: string;
          ts: number;
          action: FlowAction;
          tabId?: number;
          durationMs: number;
          result: "succeeded" | "failed" | "blocked";
          targetRef?: string;
          drift?: DriftKind;
          sensitive: boolean;
      };

export type EvidenceProfile = "none" | "failure" | "step" | "flow" | "full";

export type EvidenceQueryMode = "overview" | "events" | "failure" | "export";

export interface AssertionEvent {
    type: "assertion";
    id: string;
    timestamp: number;
    expression: string;
    result: "passed" | "failed" | "unknown";
    sensitive: boolean;
}

export interface FailureEvent {
    type: "failure";
    id: string;
    timestamp: number;
    phase: "resolve" | "risk" | "action" | "settle" | "assert" | "capture";
    code: string;
    message: string;
}

export interface ArtifactRef {
    id: string;
    kind: "screenshot" | "video" | "snapshot" | "trace" | "other";
    byteSize: number;
    redacted: boolean;
}

export type EvidenceTimelineEvent = ActionLifecycleEvent | AssertionEvent | FailureEvent;

export interface EvidenceRun {
    schemaVersion: 1;
    id: string;
    sessionId: string;
    flowId?: string;
    profile: EvidenceProfile;
    counts: {
        actions: number;
        assertions: number;
        failures: number;
        artifacts: number;
    };
    timelineRef: string;
    primaryFailureRef?: string;
}

export interface CaptureSet {
    rawVideoRef?: string;
    rawScreenshotRef?: string;
    timelineRef: string;
    annotatedVideoRef?: string;
}

export type FlowStepV2 = Omit<FlowStep, "role" | "name" | "selector" | "timeoutMs" | "confirmRisky"> & {
    target?: FlowTargetDescriptor;
    expected?: ExpectedTransition;
    policy?: FlowStepPolicy;
    role?: string;
    name?: string;
    selector?: string;
    timeoutMs?: number;
    confirmRisky?: boolean;
};

export interface FlowDocumentV2 {
    schemaVersion: 2;
    id?: string;
    name: string;
    description?: string;
    domain?: string;
    steps: FlowStepV2[];
}

export type FlowStepInput = FlowStep | FlowStepV2;

export interface FlowDocumentInput {
    schemaVersion?: number;
    id?: string;
    name: string;
    description?: string;
    domain?: string;
    steps: readonly FlowStepInput[];
}

const MAX_FLOW_DESCRIPTOR_TEXT = 200;
const MAX_FLOW_SELECTOR_HINTS = 3;

function boundedFlowDescriptorText(value: string | undefined): string | undefined {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > MAX_FLOW_DESCRIPTOR_TEXT
        ? `${normalized.slice(0, MAX_FLOW_DESCRIPTOR_TEXT - 1)}…`
        : normalized;
}

/** Builds an allowlisted durable target descriptor from a legacy step. */
export function toFlowTargetDescriptor(step: FlowStep): FlowTargetDescriptor | undefined {
    const role = boundedFlowDescriptorText(step.role);
    const name = boundedFlowDescriptorText(step.name);
    const selector = boundedFlowDescriptorText(step.selector);
    if (!role && !name && !selector) return undefined;
    return {
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(selector ? { selectorHints: [selector].slice(0, MAX_FLOW_SELECTOR_HINTS) } : {}),
    };
}

/** Migrates a legacy flow step without using its runtime node id as identity. */
export function migrateFlowStep(step: FlowStep | FlowStepV2): FlowStepV2 {
    if ("target" in step && step.target) return { ...step };
    const target = toFlowTargetDescriptor(step);
    return { ...step, ...(target ? { target } : {}) };
}

/** Converts v2 target metadata to the legacy resolver input used during migration. */
export function normalizeFlowStep(step: FlowStep | FlowStepV2): FlowStep {
    if (!("target" in step) || !step.target) return step;
    const target = step.target;
    return {
        ...step,
        role: step.role || target.role,
        name: step.name || target.name,
        selector: step.selector || target.selectorHints?.[0],
        timeoutMs: step.timeoutMs ?? step.policy?.timeoutMs,
        confirmRisky: step.confirmRisky ?? step.policy?.confirmRisky,
    };
}

/** Converts either flow document version to the v2 envelope without rewriting storage implicitly. */
export function migrateFlowDocument(document: FlowDocumentInput): FlowDocumentV2 {
    return {
        schemaVersion: 2,
        ...(document.id ? { id: document.id } : {}),
        name: document.name,
        ...(document.description ? { description: document.description } : {}),
        ...(document.domain ? { domain: document.domain } : {}),
        steps: document.steps.map(migrateFlowStep),
    };
}

export interface RuntimeTargetRef {
    ref: string;
    scope: DocumentScope;
    lastSeenRevision: string;
    confidence: number;
    status: "active" | "stale" | "uncertain";
}

export interface SemanticNode {
    ref: string;
    role?: string;
    name?: string;
    value?: string;
    parentRef?: string;
    children?: string[];
    internalBackendNodeId?: number;
    identityUncertain?: boolean;
}

export interface SemanticSnapshot {
    schemaVersion: 2;
    revision: string;
    scope: DocumentScope;
    url?: string;
    title?: string;
    truncated?: boolean;
    identityUncertainty?: boolean;
    nodes: SemanticNode[];
}

export interface SemanticDelta {
    schemaVersion: 2;
    fromRevision?: string;
    toRevision: string;
    scope: DocumentScope;
    added: SemanticNode[];
    changed: SemanticNode[];
    removed: string[];
    uncertainRefs: string[];
    truncated?: boolean;
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
type WithTabId<T> = T & { tabId?: number; sessionId?: string };

export type BrowserCommand = WithTabId<
    | { cmd: "navigate"; url: string; newTab?: boolean; background?: boolean }
    | { cmd: "snapshot"; compact?: boolean; format?: "compact" | "json"; semantic?: boolean }
    | { cmd: "query_region"; selector: string; compact?: boolean }
    | { cmd: "visual_snapshot" }
    | { cmd: "click"; nodeId?: number; ref?: string; documentId?: string; confirmRisky?: boolean }
    | { cmd: "type"; text: string; nodeId?: number; ref?: string; documentId?: string; confirmRisky?: boolean }
    | { cmd: "press_key"; key: string; nodeId?: number; ref?: string; documentId?: string; confirmRisky?: boolean }
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
    | { cmd: "network_request_detail"; requestId: string; includeBody?: boolean }
    | { cmd: "network_clear" }
    | { cmd: "inspect_element"; nodeId?: number; ref?: string; documentId?: string }
    | { cmd: "evaluate"; expression: string }
    | { cmd: "run_flow"; steps: FlowStepInput[]; domain?: string; returnSnapshot?: boolean }
    | { cmd: "explore_flow"; steps: FlowStepInput[]; domain?: string; returnSnapshot?: boolean }
    | { cmd: "list_tabs"; scope?: "workspace" | "all" }
    | { cmd: "switch_tab"; tabId: number }
    | { cmd: "peek_screen"; screenshot?: boolean; maxChars?: number; includeSelection?: boolean }
    | { cmd: "start_capture" }
    | { cmd: "stop_capture" }
    | {
          cmd: "evidence";
          mode?: EvidenceQueryMode;
          after?: number;
          limit?: number;
          sessionId?: string;
          profile?: EvidenceProfile;
      }
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
          ref?: string;
          documentId?: string;
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

export const BROWSER_COMMAND_NAMES = [
    "navigate",
    "snapshot",
    "query_region",
    "visual_snapshot",
    "click",
    "type",
    "press_key",
    "scroll",
    "drag",
    "screenshot",
    "network_requests",
    "network_request_detail",
    "network_clear",
    "inspect_element",
    "evaluate",
    "run_flow",
    "explore_flow",
    "list_tabs",
    "switch_tab",
    "peek_screen",
    "start_capture",
    "stop_capture",
    "evidence",
    "reading_mode",
    "find",
    "select_content",
    "batch_crawl",
    "close_tab",
    "web_search",
    "dev_memory",
    "dev_process",
    "dev_har",
    "dev_layout",
    "dev_emulate",
    "dev_sandbox",
    "start_flow_recording",
    "stop_flow_recording",
    "flow_recording_status",
] as const satisfies readonly BrowserCommand["cmd"][];

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
export const MAX_BINARY_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const BinaryOpcode = {
    VIDEO_CHUNK: 0x02,
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
    if (!Object.values(BinaryOpcode).includes(opcode) || payload.byteLength > MAX_BINARY_PAYLOAD_BYTES) {
        throw new RangeError("Invalid binary opcode or payload size");
    }
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
    if (!Object.values(BinaryOpcode).includes(opcode)) return null;
    const flags = data[3] ?? 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const length = view.getUint32(4, true);
    if (length > MAX_BINARY_PAYLOAD_BYTES || length !== data.byteLength - BINARY_HEADER_SIZE) return null;

    const payload = data.subarray(BINARY_HEADER_SIZE);
    return { opcode, flags, length, payload };
}

import {
  ActAction,
  BulkAction,
  DevAction,
  Gateway,
  InspectAction,
  KnowledgeAction,
  SessionAction,
} from "../../libs/gateways.js";
import type { TOOLS } from "./schemas.js";

export const CapabilityProfile = {
  Default: "default",
  Advanced: "advanced",
  Evidence: "evidence",
  Bulk: "bulk",
} as const;
export type CapabilityProfile = (typeof CapabilityProfile)[keyof typeof CapabilityProfile];

const PROFILE_VALUES = Object.values(CapabilityProfile);
type GatewayActionMap = Record<Gateway, readonly string[]>;
type GatewayTool = (typeof TOOLS)[number];
type SchemaProperty = { enum?: readonly unknown[]; [key: string]: unknown };
type InputSchema = { properties?: Record<string, SchemaProperty>; [key: string]: unknown };

const ALL_ACTIONS = {
  [Gateway.Act]: Object.values(ActAction),
  [Gateway.Inspect]: Object.values(InspectAction),
  [Gateway.Session]: Object.values(SessionAction),
  [Gateway.Bulk]: Object.values(BulkAction),
  [Gateway.Knowledge]: Object.values(KnowledgeAction),
  [Gateway.Dev]: Object.values(DevAction),
} satisfies GatewayActionMap;

function actionKeys(gateway: Gateway, actions: readonly string[]): string[] {
  return actions.map((action) => `${gateway}:${action}`);
}

const DEFAULT_ACTION_KEYS = [
  ...actionKeys(
    Gateway.Act,
    Object.values(ActAction).filter((action) => action !== ActAction.Evaluate),
  ),
  ...actionKeys(Gateway.Inspect, Object.values(InspectAction)),
  ...actionKeys(Gateway.Session, [
    SessionAction.Navigate,
    SessionAction.ListTabs,
    SessionAction.SwitchTab,
    SessionAction.CloseTab,
    SessionAction.SetSessionName,
    SessionAction.GetMetrics,
    SessionAction.GetArtifact,
  ]),
  ...actionKeys(Gateway.Knowledge, Object.values(KnowledgeAction)),
  ...actionKeys(Gateway.Dev, [
    DevAction.InspectMemory,
    DevAction.InspectProcess,
    DevAction.AnalyzeHar,
    DevAction.DebugLayout,
    DevAction.BenchmarkReport,
  ]),
];

const PROFILE_ACTION_KEYS = {
  [CapabilityProfile.Default]: new Set(DEFAULT_ACTION_KEYS),
  [CapabilityProfile.Advanced]: new Set([
    ...DEFAULT_ACTION_KEYS,
    ...actionKeys(Gateway.Act, [ActAction.Evaluate]),
    ...actionKeys(Gateway.Dev, Object.values(DevAction)),
  ]),
  [CapabilityProfile.Evidence]: new Set([
    ...DEFAULT_ACTION_KEYS,
    ...actionKeys(Gateway.Session, [SessionAction.StartRecording, SessionAction.StopRecording]),
    ...actionKeys(Gateway.Knowledge, [KnowledgeAction.RecordFlow]),
    ...actionKeys(Gateway.Dev, [DevAction.ExportHar]),
  ]),
  [CapabilityProfile.Bulk]: new Set([...DEFAULT_ACTION_KEYS, ...actionKeys(Gateway.Bulk, Object.values(BulkAction))]),
} satisfies Record<CapabilityProfile, ReadonlySet<string>>;

/** Parses the opt-in capability profile; unset keeps the pre-profile full surface for compatibility. */
export function parseCapabilityProfile(value: string | undefined): CapabilityProfile | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return PROFILE_VALUES.includes(normalized as CapabilityProfile)
    ? (normalized as CapabilityProfile)
    : CapabilityProfile.Default;
}

/** Returns whether a known gateway action is available under the selected profile. */
export function isActionAllowed(gateway: string, action: string, profile?: CapabilityProfile): boolean {
  if (!profile) return true;
  const knownActions = ALL_ACTIONS[gateway as Gateway] as readonly string[] | undefined;
  if (!knownActions?.includes(action)) return true;
  return PROFILE_ACTION_KEYS[profile].has(`${gateway}:${action}`);
}

/** Filters action enums exposed through MCP and omits gateways with no permitted action. */
export function filterTools(tools: readonly GatewayTool[], profile?: CapabilityProfile): GatewayTool[] {
  if (!profile) return [...tools];

  return tools.flatMap((tool) => {
    const inputSchema = tool.inputSchema as unknown as InputSchema;
    const actionProperty = inputSchema.properties?.action;
    if (!actionProperty?.enum) return [tool];

    const allowedActions = actionProperty.enum.filter(
      (action): action is string => typeof action === "string" && isActionAllowed(tool.name, action, profile),
    );
    if (allowedActions.length === 0) return [];

    return [
      {
        ...tool,
        inputSchema: {
          ...inputSchema,
          properties: {
            ...inputSchema.properties,
            action: { ...actionProperty, enum: allowedActions },
          },
        },
      } as unknown as GatewayTool,
    ];
  });
}

/** Adds a short policy note without duplicating the full gateway instructions. */
export function profileInstructions(base: string, profile?: CapabilityProfile): string {
  if (!profile) return base;
  return `${base}\n\nThe daemon capability profile is "${profile}". Actions not exposed by the active tool schemas are rejected server-side.`;
}

import { describe, expect, test } from "bun:test";
import { ActAction, BulkAction, DevAction, Gateway, SessionAction } from "../../libs/gateways.js";
import {
  CapabilityProfile,
  filterTools,
  isActionAllowed,
  parseCapabilityProfile,
  profileInstructions,
} from "./capabilities.js";
import { TOOLS } from "./schemas.js";

type ActionSchema = { properties?: { action?: { enum?: readonly unknown[] } } };

function actionsFor(tools: readonly (typeof TOOLS)[number][], gateway: string): readonly unknown[] {
  const tool = tools.find((candidate) => candidate.name === gateway);
  const schema = tool?.inputSchema as unknown as ActionSchema | undefined;
  return schema?.properties?.action?.enum ?? [];
}

describe("capability profiles", () => {
  test("keeps the existing full surface when no profile is configured", () => {
    expect(parseCapabilityProfile(undefined)).toBeUndefined();
    expect(filterTools(TOOLS)).toHaveLength(TOOLS.length);
    expect(isActionAllowed(Gateway.Act, ActAction.Evaluate)).toBe(true);
  });

  test("parses known values case-insensitively and fails closed for unknown values", () => {
    expect(parseCapabilityProfile("ADVANCED")).toBe(CapabilityProfile.Advanced);
    expect(parseCapabilityProfile(" Evidence ")).toBe(CapabilityProfile.Evidence);
    expect(parseCapabilityProfile("not-a-profile")).toBe(CapabilityProfile.Default);
  });

  test("exposes only safe actions in the default profile", () => {
    const tools = filterTools(TOOLS, CapabilityProfile.Default);

    expect(tools.some((tool) => tool.name === Gateway.Bulk)).toBe(false);
    expect(actionsFor(tools, Gateway.Act)).not.toContain(ActAction.Evaluate);
    expect(isActionAllowed(Gateway.Act, ActAction.Click, CapabilityProfile.Default)).toBe(true);
    expect(isActionAllowed(Gateway.Act, ActAction.Evaluate, CapabilityProfile.Default)).toBe(false);
    expect(isActionAllowed(Gateway.Bulk, BulkAction.BatchCrawl, CapabilityProfile.Default)).toBe(false);
  });

  test("adds advanced diagnostics without exposing bulk operations", () => {
    const tools = filterTools(TOOLS, CapabilityProfile.Advanced);

    expect(actionsFor(tools, Gateway.Act)).toContain(ActAction.Evaluate);
    expect(actionsFor(tools, Gateway.Dev)).toContain(DevAction.Emulate);
    expect(tools.some((tool) => tool.name === Gateway.Bulk)).toBe(false);
  });

  test("isolates evidence and bulk capabilities", () => {
    expect(isActionAllowed(Gateway.Session, SessionAction.StartRecording, CapabilityProfile.Evidence)).toBe(true);
    expect(isActionAllowed(Gateway.Bulk, BulkAction.BatchCrawl, CapabilityProfile.Evidence)).toBe(false);
    expect(isActionAllowed(Gateway.Bulk, BulkAction.BatchCrawl, CapabilityProfile.Bulk)).toBe(true);
    expect(isActionAllowed(Gateway.Session, SessionAction.StartRecording, CapabilityProfile.Bulk)).toBe(false);
  });

  test("keeps unknown actions available for the normal dispatcher error", () => {
    expect(isActionAllowed(Gateway.Act, "future_action", CapabilityProfile.Default)).toBe(true);
  });

  test("adds profile policy to MCP instructions only when selected", () => {
    expect(profileInstructions("base")).toBe("base");
    expect(profileInstructions("base", CapabilityProfile.Evidence)).toContain('profile is "evidence"');
  });
});

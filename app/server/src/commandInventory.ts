#!/usr/bin/env bun

import { BROWSER_COMMAND_NAMES, type BrowserCommand } from "@browsercontrol/shared";
import { TOOLS } from "./modules/tools/schemas.js";

type CommandName = BrowserCommand["cmd"];
type ToolSchema = { properties?: Record<string, { enum?: unknown[] }> };

const mutatingCommands = new Set<CommandName>([
  "navigate",
  "click",
  "type",
  "press_key",
  "scroll",
  "drag",
  "evaluate",
  "run_flow",
  "explore_flow",
  "switch_tab",
  "close_tab",
  "start_capture",
  "stop_capture",
  "network_clear",
  "dev_emulate",
  "dev_sandbox",
  "start_flow_recording",
  "stop_flow_recording",
]);

const persistedCommands = new Set<CommandName>([
  "screenshot",
  "stop_capture",
  "select_content",
  "start_flow_recording",
  "stop_flow_recording",
]);

const captureCommands = new Set<CommandName>([
  "screenshot",
  "start_capture",
  "stop_capture",
  "select_content",
  "network_requests",
  "network_request_detail",
  "dev_har",
]);

function actionValues(tool: (typeof TOOLS)[number]): string[] {
  const schema = tool.inputSchema as ToolSchema;
  return schema.properties?.action?.enum?.filter((value): value is string => typeof value === "string") ?? [];
}

const inventory = {
  generatedAt: new Date().toISOString(),
  sourceOfTruth: [
    "packages/shared/src/protocol.ts:BROWSER_COMMAND_NAMES",
    "app/server/src/modules/tools/schemas.ts:TOOLS",
    "app/server/src/libs/gateways.ts",
  ],
  gateways: TOOLS.map((tool) => ({ name: tool.name, actions: actionValues(tool) })),
  commands: BROWSER_COMMAND_NAMES.map((command) => ({
    command,
    transport: "authenticated /execute HTTP relay or authenticated extension WebSocket",
    mutatesBrowser: mutatingCommands.has(command),
    capturesOrPersists: captureCommands.has(command) || persistedCommands.has(command),
    requiresDebugger: !["navigate", "list_tabs", "switch_tab", "close_tab", "peek_screen"].includes(command),
    timeoutPolicy: command === "stop_capture" ? "bounded up to 60000ms" : "bounded up to 120000ms",
  })),
};

console.log(JSON.stringify(inventory, null, 2));

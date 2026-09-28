#!/usr/bin/env bun

import {
  CapabilityProfile,
  filterTools,
  parseCapabilityProfile,
  profileInstructions,
} from "./modules/tools/capabilities.js";
import { INSTRUCTIONS, TOOLS } from "./modules/tools/schemas.js";

type TokenMeasurement = {
  chars: number;
  estimatedTokens: number;
  method: "heuristic_chars_div_4";
};

type TaskScenario = {
  name: string;
  args: Record<string, unknown>;
  runtimeResponse: "measure_during_task";
  runtimeRoundtrips: "measure_during_task";
  runtimeRecovery: "measure_on_failure";
};

function measure(text: string): TokenMeasurement {
  return {
    chars: text.length,
    estimatedTokens: Math.max(1, Math.round(text.length / 4)),
    method: "heuristic_chars_div_4",
  };
}

const scenarios: TaskScenario[] = [
  {
    name: "inspect_page",
    args: { gateway: "browser_inspect", action: "snapshot" },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "unique_click",
    args: { gateway: "browser_act", action: "click", role: "button", name: "Save" },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "type_text",
    args: { gateway: "browser_act", action: "type", role: "textbox", name: "Search", text: "example" },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "three_step_flow",
    args: {
      gateway: "browser_act",
      action: "run_flow",
      steps: [{ action: "click" }, { action: "type" }, { action: "press_key" }],
    },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "selected_content",
    args: { gateway: "browser_inspect", action: "select_content", selector: "main" },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "screenshot",
    args: { gateway: "browser_inspect", action: "screenshot", format: "jpeg" },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
  {
    name: "multi_tab_job",
    args: {
      gateway: "browser_bulk",
      action: "batch_crawl",
      urls: ["https://example.test/a", "https://example.test/b"],
    },
    runtimeResponse: "measure_during_task",
    runtimeRoundtrips: "measure_during_task",
    runtimeRecovery: "measure_on_failure",
  },
];

const output = {
  generatedAt: new Date().toISOString(),
  methodology:
    "Exact character counts from current gateway definitions plus chars/4 heuristic estimates; provider tokenization is not claimed.",
  fixedCost: {
    toolSchemas: measure(JSON.stringify(TOOLS)),
    instructions: measure(INSTRUCTIONS),
    method: "heuristic_chars_div_4",
  },
  capabilityProfiles: Object.values(CapabilityProfile).map((profile) => ({
    profile,
    fixedCost: {
      toolSchemas: measure(JSON.stringify(filterTools(TOOLS, parseCapabilityProfile(profile)))),
      instructions: measure(profileInstructions(INSTRUCTIONS, parseCapabilityProfile(profile))),
    },
  })),
  taskScenarios: scenarios.map((scenario) => ({
    ...scenario,
    argumentCost: measure(JSON.stringify(scenario.args)),
  })),
  runtimeMeasurements: {
    responseTokens: "not measured by this offline command",
    snapshotTokens: "not measured by this offline command",
    deltaTokens: "not measured by this offline command",
    recoveryTokens: "not measured by this offline command",
    roundtripsPerTask: "not measured by this offline command",
  },
};

console.log(JSON.stringify(output, null, 2));

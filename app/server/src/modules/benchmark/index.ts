#!/usr/bin/env bun

/**
 * Opt-in real-Chrome runtime benchmark. It measures the authenticated daemon
 * bridge without starting a second browser or changing normal daemon behavior.
 */
import { existsSync, readFileSync } from "node:fs";
import { AUTH_TOKEN_PATH } from "../../configs/paths.js";
import { filterTools, parseCapabilityProfile, profileInstructions } from "../tools/capabilities.js";
import { INSTRUCTIONS, TOOLS } from "../tools/schemas.js";
import {
  BENCHMARK_MAX_RESPONSE_CHARS,
  BENCHMARK_TASK_COUNT,
  BENCHMARK_TIMEOUT_MS,
  DEFAULT_BENCHMARK_RUNS,
  DEFAULT_BENCHMARK_URL,
  MAX_BENCHMARK_RUNS,
} from "./constants.js";
import { buildReport, measureTokenCost, summarizeTask } from "./metrics.js";
import type { BenchmarkTaskResult, CommandExecution, CommandMeasurement, JsonRecord } from "./types.js";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:8765";
const DEFAULT_DAEMON_TIMEOUT_MS = 20_000;
const MAX_DAEMON_TIMEOUT_MS = 120_000;
const NETWORK_BENCHMARK_PATH = "/encoding/utf8";
const STALE_BENCHMARK_PATH = "/html";

interface BenchmarkConfig {
  daemonUrl: string;
  pageUrl: string;
  runs: number;
  capabilityProfile: string;
  daemonTimeoutMs: number;
}

interface BenchmarkScenario {
  name: string;
  expectedRecoveryCalls: number;
  run: ScenarioRunner;
}

type ScenarioRunner = (
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
) => Promise<void>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function envPositiveInt(name: string, fallback: number, max: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function normalizeOrigin(value: string, name: string): string {
  const url = new URL(value);
  assertCondition(url.protocol === "http:" || url.protocol === "https:", `${name} must use http:// or https://`);
  return url.origin;
}

function normalizePageUrl(value: string, name: string): string {
  const url = new URL(value);
  assertCondition(url.protocol === "http:" || url.protocol === "https:", `${name} must use http:// or https://`);
  url.hash = "";
  return url.toString();
}

function readConfig(): BenchmarkConfig {
  const daemonUrl = normalizeOrigin(
    process.env.BROWSERCONTROL_BENCHMARK_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL,
    "BROWSERCONTROL_BENCHMARK_DAEMON_URL",
  );
  const pageUrl = normalizePageUrl(
    process.env.BROWSERCONTROL_BENCHMARK_URL?.trim() || DEFAULT_BENCHMARK_URL,
    "BROWSERCONTROL_BENCHMARK_URL",
  );
  const profile = parseCapabilityProfile(process.env.BROWSERCONTROL_PROFILE);

  return {
    daemonUrl,
    pageUrl,
    runs: envPositiveInt("BROWSERCONTROL_BENCHMARK_RUNS", DEFAULT_BENCHMARK_RUNS, MAX_BENCHMARK_RUNS),
    capabilityProfile: profile ?? "unconfigured",
    daemonTimeoutMs: envPositiveInt(
      "BROWSERCONTROL_BENCHMARK_DAEMON_TIMEOUT_MS",
      DEFAULT_DAEMON_TIMEOUT_MS,
      MAX_DAEMON_TIMEOUT_MS,
    ),
  };
}

function readAuthToken(): string {
  const configured = process.env.BROWSERCONTROL_AUTH_TOKEN?.trim();
  if (configured) {
    assertCondition(configured.length >= 64, "BROWSERCONTROL_AUTH_TOKEN is invalid or incomplete");
    return configured;
  }
  if (!existsSync(AUTH_TOKEN_PATH)) {
    throw new Error("No daemon token found. Start the managed daemon once or set BROWSERCONTROL_AUTH_TOKEN.");
  }
  const persisted = readFileSync(AUTH_TOKEN_PATH, "utf8").trim();
  assertCondition(persisted.length >= 64, "The persisted daemon token is invalid or incomplete");
  return persisted;
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "Daemon returned invalid JSON" };
  }
}

class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async fetchAuthorized(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  private async readBody(response: Response): Promise<{ body: unknown; chars: number }> {
    const text = await response.text();
    if (text.length > BENCHMARK_MAX_RESPONSE_CHARS) {
      throw new Error(`Daemon response exceeds ${BENCHMARK_MAX_RESPONSE_CHARS} characters`);
    }
    return { body: parseResponseBody(text), chars: text.length };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchAuthorized(path, init);
    const { body } = await this.readBody(response);
    if (!response.ok) {
      const detail = asNonEmptyString(asRecord(body)?.error) ?? `HTTP ${response.status}`;
      throw new Error(`${response.status} ${detail.slice(0, 300)}`);
    }
    return body;
  }

  public async status(): Promise<JsonRecord> {
    const body = asRecord(await this.request("/status"));
    assertCondition(body, "Daemon status returned an invalid response");
    return body;
  }

  public async execute(cmd: string, args: JsonRecord = {}): Promise<CommandExecution> {
    const payload = { cmd, ...args, timeoutMs: BENCHMARK_TIMEOUT_MS } satisfies JsonRecord;
    const inputChars = JSON.stringify(payload).length;
    const startedAt = performance.now();
    const response = await this.fetchAuthorized(
      "/execute",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      BENCHMARK_TIMEOUT_MS + 5_000,
    );
    const { body, chars: outputChars } = await this.readBody(response);
    const envelope = asRecord(body);
    const result = envelope && "result" in envelope ? envelope.result : body;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const detail = asNonEmptyString(envelope?.error) ?? `HTTP ${response.status}`;

    return {
      result,
      measurement: {
        cmd,
        inputChars,
        outputChars,
        durationMs,
        ok: response.ok,
        ...(response.ok ? {} : { error: `${response.status} ${detail.slice(0, 300)}` }),
      },
    };
  }
}

async function waitForExtension(client: DaemonClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "extension is not connected";
  while (Date.now() < deadline) {
    try {
      const status = await client.status();
      if (status.extensionConnected === true) return;
      lastError = "extension is not connected";
    } catch (error) {
      lastError = errorText(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the authenticated extension: ${lastError}`);
}

async function executeRequired(client: DaemonClient, cmd: string, args: JsonRecord = {}): Promise<unknown> {
  const execution = await client.execute(cmd, args);
  if (!execution.measurement.ok) {
    throw new Error(execution.measurement.error ?? `${cmd} failed`);
  }
  return execution.result;
}

async function command(
  client: DaemonClient,
  cmd: string,
  args: JsonRecord,
  measurements: CommandMeasurement[],
): Promise<unknown> {
  const execution = await client.execute(cmd, args);
  measurements.push(execution.measurement);
  if (!execution.measurement.ok) {
    throw new Error(execution.measurement.error ?? `${cmd} failed`);
  }
  return execution.result;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  const result = asRecord(value);
  assertCondition(result, `${label} returned an invalid result`);
  return result;
}

function requireNavigation(value: unknown, tabId: number, label: string): void {
  const result = requireRecord(value, label);
  assertCondition(result.success === true, `${label} failed`);
  assertCondition(asNumber(result.tabId) === tabId, `${label} returned an unexpected tab id`);
}

async function navigate(
  client: DaemonClient,
  tabId: number,
  url: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  const result = await command(client, "navigate", { tabId, url, background: false }, measurements);
  requireNavigation(result, tabId, "navigate");
}

function semanticTarget(value: unknown, label: string): { documentId: string; ref: string } {
  const result = requireRecord(value, label);
  const snapshot = asRecord(result.snapshot);
  const scope = asRecord(snapshot?.scope);
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const documentId = asNonEmptyString(scope?.documentId);
  const node = nodes.map((item) => asRecord(item)).find((item) => asNonEmptyString(item?.ref) !== null);
  const ref = asNonEmptyString(node?.ref);
  assertCondition(documentId && ref && nodes.length > 0, `${label} did not return a usable semantic target`);
  return { documentId, ref };
}

async function runSemanticSnapshot(
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  await navigate(client, tabId, pageUrl, measurements);
  const result = await command(client, "snapshot", { tabId, semantic: true }, measurements);
  semanticTarget(result, "semantic snapshot");
}

async function runBatchedSafeFlow(
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  await navigate(client, tabId, pageUrl, measurements);
  const fieldSelector = 'input[name="custname"]';
  const result = requireRecord(
    await command(
      client,
      "run_flow",
      {
        tabId,
        returnSnapshot: true,
        steps: [
          { action: "click", selector: fieldSelector },
          { action: "type", selector: fieldSelector, text: "BrowserControl benchmark" },
          { action: "press_key", selector: fieldSelector, key: "Tab" },
          { action: "scroll", deltaY: 120 },
        ],
      },
      measurements,
    ),
    "batched safe flow",
  );
  assertCondition(
    result.success === true,
    `batched safe flow failed: ${asNonEmptyString(result.message) ?? "unknown error"}`,
  );
}

async function runVisualCapture(
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  await navigate(client, tabId, pageUrl, measurements);
  const result = requireRecord(await command(client, "visual_snapshot", { tabId }, measurements), "visual snapshot");
  assertCondition(Array.isArray(result.nodes), "visual snapshot returned no nodes");
  assertCondition(asNonEmptyString(result.dataBase64) !== null, "visual snapshot returned no image data");
}

async function runNetworkObservation(
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  const networkUrl = new URL(NETWORK_BENCHMARK_PATH, pageUrl).toString();
  await navigate(client, tabId, networkUrl, measurements);
  const result = requireRecord(
    await command(client, "network_requests", { tabId, limit: 20 }, measurements),
    "network observation",
  );
  assertCondition(Array.isArray(result.requests), "network observation returned no request list");
}

async function runStaleReferenceRecovery(
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
  measurements: CommandMeasurement[],
): Promise<void> {
  await navigate(client, tabId, pageUrl, measurements);
  const initialSnapshot = await command(client, "snapshot", { tabId, semantic: true }, measurements);
  const staleTarget = semanticTarget(initialSnapshot, "initial semantic snapshot");

  const changedUrl = new URL(STALE_BENCHMARK_PATH, pageUrl).toString();
  await navigate(client, tabId, changedUrl, measurements);
  const freshSnapshot = await command(client, "snapshot", { tabId, semantic: true }, measurements);
  const freshTarget = semanticTarget(freshSnapshot, "fresh semantic snapshot");

  const staleResult = requireRecord(
    await command(
      client,
      "inspect_element",
      { tabId, ref: staleTarget.ref, documentId: staleTarget.documentId },
      measurements,
    ),
    "stale reference check",
  );
  assertCondition(asNonEmptyString(staleResult.error) !== null, "stale semantic ref was not rejected");
  const inspected = requireRecord(
    await command(
      client,
      "inspect_element",
      { tabId, ref: freshTarget.ref, documentId: freshTarget.documentId },
      measurements,
    ),
    "fresh reference recovery",
  );
  assertCondition(asNonEmptyString(inspected.error) === null, "fresh semantic ref could not be inspected");
}

const SCENARIOS = [
  { name: "semantic_snapshot", expectedRecoveryCalls: 0, run: runSemanticSnapshot },
  { name: "batched_safe_flow", expectedRecoveryCalls: 0, run: runBatchedSafeFlow },
  { name: "visual_capture", expectedRecoveryCalls: 0, run: runVisualCapture },
  { name: "network_observation", expectedRecoveryCalls: 0, run: runNetworkObservation },
  { name: "stale_reference_recovery", expectedRecoveryCalls: 2, run: runStaleReferenceRecovery },
] satisfies readonly BenchmarkScenario[];

function fixedCostForProfile(profile: ReturnType<typeof parseCapabilityProfile>): {
  toolSchemas: ReturnType<typeof measureTokenCost>;
  instructions: ReturnType<typeof measureTokenCost>;
} {
  return {
    toolSchemas: measureTokenCost(JSON.stringify(filterTools(TOOLS, profile)) ?? ""),
    instructions: measureTokenCost(profileInstructions(INSTRUCTIONS, profile)),
  };
}

async function runTask(
  scenario: BenchmarkScenario,
  run: number,
  client: DaemonClient,
  tabId: number,
  pageUrl: string,
): Promise<BenchmarkTaskResult> {
  const measurements: CommandMeasurement[] = [];
  try {
    await scenario.run(client, tabId, pageUrl, measurements);
    return summarizeTask(scenario.name, run, measurements, scenario.expectedRecoveryCalls);
  } catch (error) {
    return summarizeTask(scenario.name, run, measurements, scenario.expectedRecoveryCalls, errorText(error));
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  assertCondition(SCENARIOS.length === BENCHMARK_TASK_COUNT, "Benchmark scenario count does not match its contract");
  const parsedProfile = parseCapabilityProfile(process.env.BROWSERCONTROL_PROFILE);
  const client = new DaemonClient(config.daemonUrl, readAuthToken());
  await waitForExtension(client, config.daemonTimeoutMs);

  let tabId: number | null = null;
  const tasks: BenchmarkTaskResult[] = [];
  try {
    const navigation = requireRecord(
      await executeRequired(client, "navigate", { url: config.pageUrl, newTab: true, background: false }),
      "benchmark tab creation",
    );
    tabId = asNumber(navigation.tabId);
    assertCondition(tabId !== null, "benchmark tab creation did not return a tab id");

    for (let run = 1; run <= config.runs; run++) {
      for (const scenario of SCENARIOS) {
        tasks.push(await runTask(scenario, run, client, tabId, config.pageUrl));
      }
    }
  } finally {
    if (tabId !== null) {
      await executeRequired(client, "close_tab", { tabId }).catch(() => undefined);
    }
  }

  const report = buildReport(
    {
      daemonOrigin: config.daemonUrl,
      pageOrigin: new URL(config.pageUrl).origin,
      runs: config.runs,
      capabilityProfile: config.capabilityProfile,
    },
    fixedCostForProfile(parsedProfile),
    tasks,
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.successfulTaskRuns !== report.summary.taskRuns) process.exitCode = 1;
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(`Runtime benchmark failed: ${errorText(error)}`);
    process.exitCode = 1;
  });
}

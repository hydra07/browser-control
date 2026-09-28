#!/usr/bin/env bun

/**
 * Phase 1.5 local integration harness. It drives the shipped extension through
 * the daemon and real Chrome; it is deliberately separate from `bun test`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_TOKEN_PATH } from "../../configs/paths.js";
import { type FixtureServer, startFixtureServer } from "./fixture.js";

type ManagedProcess = ReturnType<typeof Bun.spawn>;
type JsonRecord = Record<string, unknown>;

type SnapshotNode = {
  i?: number;
  r?: string;
  n?: string;
  children?: SnapshotNode[];
};

interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
}

interface CdpVersion {
  Browser?: string;
  "Protocol-Version"?: string;
}

interface HarnessConfig {
  cdpUrl: string;
  daemonUrl: string;
  authToken?: string;
  chromePath?: string;
  profilePath?: string;
  extensionId?: string;
  launchChrome: boolean;
  manageDaemon: boolean;
  cdpTimeoutMs: number;
  daemonTimeoutMs: number;
  fixturePort: number;
}

interface ChromeHandle {
  process: ManagedProcess | null;
  cdpUrl: string;
}

interface DaemonHandle {
  process: ManagedProcess | null;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
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

function envPort(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function normalizeHttpUrl(value: string, name: string): string {
  const url = new URL(value);
  assertCondition(url.protocol === "http:" || url.protocol === "https:", `${name} must use http:// or https://`);
  return url.origin;
}

function toWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readConfig(): HarnessConfig {
  const cdpUrl = normalizeHttpUrl(
    process.env.BROWSERCONTROL_INTEGRATION_CDP_URL?.trim() || "http://127.0.0.1:9222",
    "BROWSERCONTROL_INTEGRATION_CDP_URL",
  );
  const daemonUrl = normalizeHttpUrl(
    process.env.BROWSERCONTROL_INTEGRATION_DAEMON_URL?.trim() || "http://127.0.0.1:8765",
    "BROWSERCONTROL_INTEGRATION_DAEMON_URL",
  );
  const daemonMode = process.env.BROWSERCONTROL_INTEGRATION_DAEMON_MODE?.trim().toLowerCase() || "managed";
  assertCondition(
    daemonMode === "managed" || daemonMode === "external",
    "BROWSERCONTROL_INTEGRATION_DAEMON_MODE must be managed or external",
  );

  const launchChrome = envBoolean("BROWSERCONTROL_INTEGRATION_LAUNCH_CHROME", false);
  const chromePath = process.env.BROWSERCONTROL_INTEGRATION_CHROME_PATH?.trim() || undefined;
  const profilePath = process.env.BROWSERCONTROL_INTEGRATION_PROFILE?.trim() || undefined;
  if (launchChrome) {
    assertCondition(chromePath, "Set BROWSERCONTROL_INTEGRATION_CHROME_PATH when launching Chrome");
    assertCondition(
      profilePath,
      "Set BROWSERCONTROL_INTEGRATION_PROFILE to a dedicated pre-provisioned profile when launching Chrome",
    );
  }

  return {
    cdpUrl,
    daemonUrl,
    authToken:
      process.env.BROWSERCONTROL_INTEGRATION_AUTH_TOKEN?.trim() ||
      process.env.BROWSERCONTROL_AUTH_TOKEN?.trim() ||
      undefined,
    chromePath,
    profilePath,
    extensionId: process.env.BROWSERCONTROL_INTEGRATION_EXTENSION_ID?.trim() || undefined,
    launchChrome,
    manageDaemon: daemonMode === "managed",
    cdpTimeoutMs: envPositiveInt("BROWSERCONTROL_INTEGRATION_CDP_TIMEOUT_MS", 15000, 120000),
    daemonTimeoutMs: envPositiveInt("BROWSERCONTROL_INTEGRATION_DAEMON_TIMEOUT_MS", 20000, 120000),
    fixturePort: envPort("BROWSERCONTROL_INTEGRATION_FIXTURE_PORT", 0),
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {}
  if (!response.ok) {
    const record = asRecord(body);
    const detail = asNonEmptyString(record?.error) ?? `HTTP ${response.status}`;
    throw new Error(`${response.status} ${detail.slice(0, 300)}`);
  }
  return body;
}

async function waitFor<T>(label: string, timeoutMs: number, action: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const result = await action();
      if (result !== null) return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError}`);
}

async function getCdpVersion(cdpUrl: string): Promise<CdpVersion> {
  const body = await fetchJson(`${cdpUrl}/json/version`);
  const record = asRecord(body);
  assertCondition(record, "Chrome /json/version returned an invalid response");
  return {
    Browser: asNonEmptyString(record.Browser) ?? undefined,
    "Protocol-Version": asNonEmptyString(record["Protocol-Version"]) ?? undefined,
  };
}

async function listCdpTargets(cdpUrl: string): Promise<CdpTarget[]> {
  const body = await fetchJson(`${cdpUrl}/json/list`);
  assertCondition(Array.isArray(body), "Chrome /json/list returned an invalid response");
  const targets: CdpTarget[] = [];
  for (const item of body as unknown[]) {
    const record = asRecord(item);
    if (!record) continue;
    targets.push({
      id: asNonEmptyString(record.id) ?? undefined,
      type: asNonEmptyString(record.type) ?? undefined,
      title: asNonEmptyString(record.title) ?? undefined,
      url: asNonEmptyString(record.url) ?? undefined,
    });
  }
  return targets;
}

async function startChrome(config: HarnessConfig, fixtureUrl: string): Promise<ChromeHandle> {
  if (!config.launchChrome) {
    await waitFor("an existing Chrome remote-debugging endpoint", config.cdpTimeoutMs, async () => {
      try {
        return await getCdpVersion(config.cdpUrl);
      } catch {
        return null;
      }
    });
    return { process: null, cdpUrl: config.cdpUrl };
  }

  const port = Number(new URL(config.cdpUrl).port || 9222);
  const chromeProcess = Bun.spawn(
    [
      config.chromePath!,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${config.profilePath!}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      fixtureUrl,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  await waitFor("the launched Chrome remote-debugging endpoint", config.cdpTimeoutMs, async () => {
    try {
      return await getCdpVersion(config.cdpUrl);
    } catch {
      return null;
    }
  });
  return { process: chromeProcess, cdpUrl: config.cdpUrl };
}

async function stopChrome(handle: ChromeHandle): Promise<void> {
  if (!handle.process) return;
  handle.process.kill();
  await Promise.race([handle.process.exited, sleep(2000)]);
}

function authTokenFor(config: HarnessConfig): string {
  if (config.authToken) return config.authToken;
  if (!existsSync(AUTH_TOKEN_PATH)) {
    throw new Error(
      `No daemon token found. Start the managed daemon once or set BROWSERCONTROL_INTEGRATION_AUTH_TOKEN; the harness never prints or commits the token.`,
    );
  }
  const token = readFileSync(AUTH_TOKEN_PATH, "utf8").trim();
  assertCondition(token.length >= 64, "The persisted daemon token is invalid or incomplete");
  return token;
}

async function endpointReachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/status`);
    return true;
  } catch {
    return false;
  }
}

async function startDaemon(config: HarnessConfig): Promise<DaemonHandle> {
  if (!config.manageDaemon) return { process: null };
  if (await endpointReachable(config.daemonUrl)) {
    throw new Error(
      `The daemon endpoint is already in use. Set BROWSERCONTROL_INTEGRATION_DAEMON_MODE=external to test an existing daemon instead.`,
    );
  }

  const serverDir = join(import.meta.dir, "..", "..", "..");
  const daemonEnv = { ...process.env };
  if (config.authToken) daemonEnv.BROWSERCONTROL_AUTH_TOKEN = config.authToken;
  const daemonProcess = Bun.spawn([process.execPath, "run", "src/daemon.ts"], {
    cwd: serverDir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: daemonEnv,
  });
  return { process: daemonProcess };
}

async function stopDaemon(handle: DaemonHandle): Promise<void> {
  if (!handle.process) return;
  handle.process.kill();
  await Promise.race([handle.process.exited, sleep(2000)]);
}

class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  public async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return fetchJson(`${this.baseUrl}${path}`, { ...init, headers });
  }

  public async status(): Promise<JsonRecord> {
    const body = asRecord(await this.request("/status"));
    assertCondition(body, "Daemon status returned an invalid response");
    return body;
  }

  public async execute(cmd: string, args: JsonRecord = {}): Promise<unknown> {
    const body = asRecord(
      await this.request("/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, ...args }),
      }),
    );
    assertCondition(body, `Daemon ${cmd} returned an invalid response`);
    return body.result;
  }
}

async function waitForExtension(client: DaemonClient, timeoutMs: number): Promise<void> {
  await waitFor("the authenticated extension WebSocket", timeoutMs, async () => {
    const status = await client.status().catch(() => null);
    if (status?.extensionConnected !== true) return null;
    return status;
  });
}

async function verifyUnauthenticatedHttp(daemonUrl: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/status`);
  assertCondition(response.status === 401, `Unauthenticated /status expected HTTP 401, got ${response.status}`);
}

async function verifyInvalidWebSocket(daemonUrl: string): Promise<void> {
  const socket = new WebSocket(toWebSocketUrl(daemonUrl));
  const closeCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Invalid WebSocket hello was not rejected within the timeout"));
    }, 5000);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: 2,
          role: "extension",
          token: "invalid-integration-token",
          clientVersion: "integration-harness",
        }),
      );
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
    socket.onerror = () => {};
  });
  assertCondition(closeCode === 1008, `Invalid WebSocket hello expected close 1008, got ${closeCode}`);
}

function flattenSnapshot(value: unknown, output: SnapshotNode[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value as unknown[]) {
    const record = asRecord(item);
    if (!record) continue;
    const node: SnapshotNode = {
      i: asNumber(record.i) ?? undefined,
      r: asNonEmptyString(record.r) ?? undefined,
      n: asNonEmptyString(record.n) ?? undefined,
    };
    const children: SnapshotNode[] = [];
    flattenSnapshot(record.children, children);
    if (children.length > 0) node.children = children;
    output.push(node);
    if (children.length > 0) output.push(...children);
  }
}

function nodeByIdentity(nodes: SnapshotNode[], role: string, name: string): SnapshotNode & { i: number } {
  const matches = nodes.filter((node) => node.r === role && node.n === name);
  assertCondition(
    matches.length === 1,
    `Expected exactly one ${role} named ${JSON.stringify(name)}, found ${matches.length}`,
  );
  const node = matches[0];
  const nodeId = node?.i;
  assertCondition(node !== undefined && nodeId !== undefined, `${role} ${JSON.stringify(name)} has no backend node id`);
  return { ...node, i: nodeId };
}

async function snapshot(client: DaemonClient, tabId: number): Promise<SnapshotNode[]> {
  const result = asRecord(await client.execute("snapshot", { tabId }));
  assertCondition(result, "snapshot returned an invalid result");
  const nodes: SnapshotNode[] = [];
  flattenSnapshot(result.nodes, nodes);
  assertCondition(nodes.length > 0, "snapshot returned no accessible nodes");
  return nodes;
}

async function evaluate(client: DaemonClient, tabId: number, expression: string): Promise<unknown> {
  const result = asRecord(await client.execute("evaluate", { tabId, expression }));
  assertCondition(result?.success === true, "evaluate did not complete successfully");
  return result.result;
}

function assertActionSuccess(value: unknown, label: string): JsonRecord {
  const result = asRecord(value);
  assertCondition(result?.success === true, `${label} failed: ${asNonEmptyString(result?.error) ?? "unknown error"}`);
  return result;
}

async function runBrowserSmoke(client: DaemonClient, fixture: FixtureServer): Promise<void> {
  const navigation = asRecord(await client.execute("navigate", { url: fixture.url, newTab: true, background: false }));
  const tabId = asNumber(navigation?.tabId);
  assertCondition(tabId !== null, "navigate did not return a tab id");

  let nodes = await snapshot(client, tabId);
  const uniqueButton = nodeByIdentity(nodes, "button", "Unique action");
  assertActionSuccess(await client.execute("click", { tabId, nodeId: uniqueButton.i }), "unique click");
  assertCondition(
    (await evaluate(client, tabId, "document.querySelector('#fixture-status')?.textContent")) === "clicked",
    "unique click did not update the fixture",
  );

  nodes = await snapshot(client, tabId);
  const nameInput = nodeByIdentity(nodes, "textbox", "Name input");
  const typedValue = "BrowserControl integration";
  assertActionSuccess(await client.execute("type", { tabId, nodeId: nameInput.i, text: typedValue }), "unique type");
  assertCondition(
    (await evaluate(client, tabId, "document.querySelector('#name-input')?.value")) === typedValue,
    "typed text did not land in the unique input",
  );

  nodes = await snapshot(client, tabId);
  const keyInput = nodeByIdentity(nodes, "textbox", "Key input");
  assertActionSuccess(await client.execute("press_key", { tabId, nodeId: keyInput.i, key: "Enter" }), "press key");
  assertCondition(
    (await evaluate(client, tabId, "document.querySelector('#fixture-status')?.textContent")) === "pressed:Enter",
    "Enter did not reach the fixture",
  );

  const nextUrl = fixture.url.replace(/\/fixture$/, "/fixture/next");
  assertActionSuccess(await client.execute("navigate", { tabId, url: nextUrl, background: false }), "navigation");
  assertCondition(
    (await evaluate(client, tabId, "location.pathname")) === "/fixture/next",
    "navigation did not reach the fixture target",
  );
  assertActionSuccess(
    await client.execute("navigate", { tabId, url: fixture.url, background: false }),
    "return navigation",
  );

  nodes = await snapshot(client, tabId);
  const staleTarget = nodeByIdentity(nodes, "button", "Rerender target");
  await evaluate(
    client,
    tabId,
    "(() => { const node = document.querySelector('#rerender-control'); if (!node) throw new Error('rerender control missing'); node.replaceWith(node.cloneNode(true)); return 'rerendered'; })()",
  );
  let staleActionRejected = false;
  try {
    const staleResult = await client.execute("click", { tabId, nodeId: staleTarget.i });
    staleActionRejected = asRecord(staleResult)?.success !== true;
  } catch {
    staleActionRejected = true;
  }
  assertCondition(staleActionRejected, "a backend node id survived a same-document replacement unexpectedly");

  const ambiguous = asRecord(
    await client.execute("run_flow", {
      tabId,
      steps: [{ action: "click", role: "button", name: "Duplicate target", timeoutMs: 2000 }],
    }),
  );
  assertCondition(
    ambiguous?.success === false && ambiguous.reason === "ambiguous",
    "duplicate semantic target was not rejected fail-closed",
  );

  nodes = await snapshot(client, tabId);
  const passwordInput = nodeByIdentity(nodes, "textbox", "Password input");
  assertActionSuccess(await client.execute("start_flow_recording", { tabId }), "start flow recording");
  const fixturePassword = "fixture-password-value";
  assertActionSuccess(
    await client.execute("type", { tabId, nodeId: passwordInput.i, text: fixturePassword }),
    "password type",
  );
  const recording = asRecord(await client.execute("stop_flow_recording"));
  assertCondition(recording, "stop flow recording returned an invalid result");
  assertCondition(recording.stepCount === 0, "password input produced a recorded flow step");
  assertCondition(
    !JSON.stringify(recording.steps ?? []).includes(fixturePassword),
    "password value appeared in recorded steps",
  );

  assertActionSuccess(await client.execute("close_tab", { tabId }), "close fixture tab");
}

interface ReattachResult {
  client: DaemonClient;
  tabId: number | null;
}

async function verifyReattachAfterDaemonRestart(
  client: DaemonClient,
  daemon: DaemonHandle,
  config: HarnessConfig,
  fixture: FixtureServer,
): Promise<ReattachResult> {
  if (!daemon.process) return { client, tabId: null };
  await stopDaemon(daemon);
  await waitFor("the managed daemon to stop", 5000, async () =>
    (await endpointReachable(config.daemonUrl)) ? null : true,
  );

  daemon.process = null;
  const restarted = await startDaemon(config);
  daemon.process = restarted.process;
  const restartedClient = new DaemonClient(config.daemonUrl, authTokenFor(config));
  await waitForExtension(restartedClient, config.daemonTimeoutMs);
  const navigation = asRecord(
    await restartedClient.execute("navigate", { url: fixture.url, newTab: true, background: false }),
  );
  const tabId = asNumber(navigation?.tabId);
  assertCondition(tabId !== null, "post-disconnect navigation did not return a tab id");
  return { client: restartedClient, tabId };
}

async function main(): Promise<void> {
  const config = readConfig();
  const fixture = startFixtureServer(config.fixturePort);
  let chrome: ChromeHandle | null = null;
  const daemon: DaemonHandle = { process: null };

  try {
    chrome = await startChrome(config, fixture.url);
    const version = await getCdpVersion(chrome.cdpUrl);
    console.log(`Chrome endpoint ready${version.Browser ? ` (${version.Browser})` : ""}`);

    const startedDaemon = await startDaemon(config);
    daemon.process = startedDaemon.process;
    const client = new DaemonClient(config.daemonUrl, authTokenFor(config));

    await waitForExtension(client, config.daemonTimeoutMs);
    await verifyUnauthenticatedHttp(config.daemonUrl);
    await verifyInvalidWebSocket(config.daemonUrl);

    const targets = await listCdpTargets(chrome.cdpUrl);
    if (config.extensionId) {
      const extensionTarget = targets.find((target) =>
        target.url?.startsWith(`chrome-extension://${config.extensionId}/`),
      );
      assertCondition(
        extensionTarget,
        "The configured extension id is not visible in the Chrome remote-debugging targets",
      );
    } else {
      console.log(
        "Note: set BROWSERCONTROL_INTEGRATION_EXTENSION_ID to assert the installed extension target explicitly.",
      );
    }

    await runBrowserSmoke(client, fixture);
    const reattached = await verifyReattachAfterDaemonRestart(client, daemon, config, fixture);
    if (reattached.tabId !== null) {
      await assertActionSuccess(
        await reattached.client.execute("close_tab", { tabId: reattached.tabId }),
        "final cleanup",
      );
    }
    console.log("Phase 1.5 integration smoke passed");
  } finally {
    await stopDaemon(daemon);
    if (chrome) await stopChrome(chrome);
    await fixture.stop();
  }
}

void main().catch((error: unknown) => {
  console.error(`Phase 1.5 integration smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

/**
 * Tracks recent command history for this daemon session and flags known-bad
 * patterns as they happen — a live nudge, since `instructions` is only read
 * once at MCP initialize and a long session tends to drift from it.
 */

import { HISTORY_LIMIT, INTERACTION_LIKE_EVALUATE, INTERACTIVE_CMDS, MAX_TRACKED_TABS } from "./constants.js";
import type { HistoryEntry } from "./types.js";

const history: HistoryEntry[] = [];

/**
 * Keyed per tab ("default" bucket for calls that omit tabId) so a snapshot
 * on tab A doesn't silence the "click with no snapshot" warning for tab B.
 */
const snapshottedSinceNavigate = new Map<string, boolean>();

function tabKey(args: Record<string, unknown>): string {
  const tabId = args?.tabId;
  return typeof tabId === "number" ? String(tabId) : "__default__";
}

/**
 * Last `count` occurrences of `cmd` across the full retained history —
 * filter-then-slice, not slice-then-filter, so an interleaved call (e.g. a
 * snapshot between two clicks) doesn't push a real occurrence out of a
 * small fixed-size window.
 */
function lastOfType(cmd: string, count: number): HistoryEntry[] {
  return history.filter((h) => h.cmd === cmd).slice(-count);
}

/** Records one command and returns a pipe-joined warning string if a known-bad pattern just triggered, else undefined. */
export function recordAndCheckFlow(cmd: string, args: Record<string, unknown>): string | undefined {
  history.push({ cmd, args });
  while (history.length > HISTORY_LIMIT) history.shift();

  if (cmd === "navigate") {
    // background:true (start_job worker tabs) never drives click/type — nothing to track.
    if (!args?.background) {
      if (snapshottedSinceNavigate.size >= MAX_TRACKED_TABS) snapshottedSinceNavigate.clear();
      snapshottedSinceNavigate.set(tabKey(args), false);
    }
    return undefined;
  }
  if (cmd === "snapshot" || cmd === "visual_snapshot" || cmd === "query_region") {
    snapshottedSinceNavigate.set(tabKey(args), true);
  }

  const warnings: string[] = [];

  if (cmd === "evaluate" && typeof args?.expression === "string" && INTERACTION_LIKE_EVALUATE.test(args.expression)) {
    const priorInteractionEvaluates = lastOfType("evaluate", 10).filter(
      (h) => typeof h.args?.expression === "string" && INTERACTION_LIKE_EVALUATE.test(h.args.expression),
    );
    if (priorInteractionEvaluates.length >= 2) {
      warnings.push(
        `flow: this is your ${priorInteractionEvaluates.length}th recent browser_act({action:"evaluate"}) call that looks like it's simulating a click/input (.value=, .click(), dispatchEvent). Switch to browser_act({action:"click"/"type"}) — evaluate-set values don't reliably trigger React/Vue's real event handlers, so you may be testing something that doesn't work the way you think it does.`,
      );
    }
  }

  if (cmd === "screenshot" || cmd === "visual_snapshot") {
    const count = lastOfType("screenshot", HISTORY_LIMIT).length + lastOfType("visual_snapshot", HISTORY_LIMIT).length;
    if (count >= 3) {
      warnings.push(
        `flow: you've captured ${count} screenshots in the last ${HISTORY_LIMIT} commands. Each one costs real tokens — prefer browser_inspect({action:"snapshot"}) (text-only) unless you specifically need to see layout/styling right now.`,
      );
    }
  }

  if ((cmd === "click" || cmd === "type") && !snapshottedSinceNavigate.get(tabKey(args))) {
    warnings.push(
      `flow: acting on a node id with no snapshot/visual_snapshot/query_region call since the last navigate. If this id came from an old snapshot it may be stale — expect "Failed to resolve node bounds" if so.`,
    );
  }

  if (cmd === "explore_flow") {
    const count = lastOfType("explore_flow", HISTORY_LIMIT).length;
    if (count >= 2) {
      warnings.push(
        `flow: you have run explore:true ${count} times recently. explore:true dumps full deltas per step and consumes large amounts of tokens. If the UI structure is already understood, switch to plain browser_act({action:"run_flow"}) to save ~80% tokens.`,
      );
    }
  }

  if (
    cmd === "network_requests" &&
    (!args?.resourceTypes || (Array.isArray(args.resourceTypes) && args.resourceTypes.length === 0))
  ) {
    warnings.push(
      `flow: network_requests called without resourceTypes filter. Pass resourceTypes: ["XHR", "Fetch"] and limit: 10 to avoid dumping hundreds of static asset requests and burning context.`,
    );
  }

  if (INTERACTIVE_CMDS.has(cmd)) {
    const recentInteractives = history.filter((h) => INTERACTIVE_CMDS.has(h.cmd)).slice(-5);
    if (recentInteractives.length >= 3) {
      warnings.push(
        `flow: you are running multiple standalone interactions in a row (${recentInteractives.map((h) => h.cmd).join(" -> ")}). Combine multi-step actions into a single browser_act({action:"run_flow", steps:[...]}) call to eliminate round-trip latency and save tokens.`,
      );
    }
  }

  return warnings.length > 0 ? warnings.join(" | ") : undefined;
}

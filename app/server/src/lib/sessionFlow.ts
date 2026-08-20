// Tracks recent command history for this daemon session and flags known-bad
// patterns as they happen — a live nudge, since `instructions` is only read
// once at MCP initialize and a long session tends to drift from it.

interface HistoryEntry {
  cmd: string;
  args: Record<string, unknown>;
}

const HISTORY_LIMIT = 15;
const history: HistoryEntry[] = [];

// Keyed per tab ("default" bucket for calls that omit tabId) so a snapshot
// on tab A doesn't silence the "click with no snapshot" warning for tab B.
// Capped well past any realistic tab count — advisory state, not durable.
const snapshottedSinceNavigate = new Map<string, boolean>();
const MAX_TRACKED_TABS = 100;

function tabKey(args: Record<string, unknown>): string {
  const tabId = args?.tabId;
  return typeof tabId === 'number' ? String(tabId) : '__default__';
}

const INTERACTION_LIKE_EVALUATE = /\.value\s*=|\.click\(\)|\.checked\s*=|dispatchEvent/;

// Last `count` occurrences of `cmd` across the full retained history —
// filter-then-slice, not slice-then-filter, so an interleaved call (e.g. a
// snapshot between two clicks) doesn't push a real occurrence out of a
// small fixed-size window.
function lastOfType(cmd: string, count: number): HistoryEntry[] {
  return history.filter((h) => h.cmd === cmd).slice(-count);
}

export function recordAndCheckFlow(cmd: string, args: Record<string, unknown>): string | undefined {
  history.push({ cmd, args });
  while (history.length > HISTORY_LIMIT) history.shift();

  if (cmd === 'navigate') {
    // background:true (browser_bulk's start_job worker tabs) has no tabId
    // yet at call time and never drives click/type — nothing to track.
    if (!args?.background) {
      if (snapshottedSinceNavigate.size >= MAX_TRACKED_TABS) snapshottedSinceNavigate.clear();
      snapshottedSinceNavigate.set(tabKey(args), false);
    }
    return undefined;
  }
  if (cmd === 'snapshot' || cmd === 'visual_snapshot' || cmd === 'query_region') {
    snapshottedSinceNavigate.set(tabKey(args), true);
  }

  const warnings: string[] = [];

  if (cmd === 'evaluate' && typeof args?.expression === 'string' && INTERACTION_LIKE_EVALUATE.test(args.expression)) {
    const priorInteractionEvaluates = lastOfType('evaluate', 10)
      .filter((h) => typeof h.args?.expression === 'string' && INTERACTION_LIKE_EVALUATE.test(h.args.expression));
    if (priorInteractionEvaluates.length >= 2) {
      warnings.push(`flow: this is your ${priorInteractionEvaluates.length}th recent browser_act({action:"evaluate"}) call that looks like it's simulating a click/input (.value=, .click(), dispatchEvent). Switch to browser_act({action:"click"/"type"}) — evaluate-set values don't reliably trigger React/Vue's real event handlers, so you may be testing something that doesn't work the way you think it does.`);
    }
  }

  if (cmd === 'screenshot' || cmd === 'visual_snapshot') {
    const count = lastOfType('screenshot', HISTORY_LIMIT).length + lastOfType('visual_snapshot', HISTORY_LIMIT).length;
    if (count >= 3) {
      warnings.push(`flow: you've captured ${count} screenshots in the last ${HISTORY_LIMIT} commands. Each one costs real tokens — prefer browser_inspect({action:"snapshot"}) (text-only) unless you specifically need to see layout/styling right now.`);
    }
  }

  if ((cmd === 'click' || cmd === 'type') && !snapshottedSinceNavigate.get(tabKey(args))) {
    warnings.push(`flow: acting on a node id with no snapshot/visual_snapshot/query_region call since the last navigate. If this id came from an old snapshot it may be stale — expect "Failed to resolve node bounds" if so.`);
  }

  if (cmd === 'click') {
    // Not scoped to "in a row" — the same nodeId as the last two clicks,
    // even with a snapshot between them, is the "clicked, saw no change,
    // clicked again" pattern this is meant to catch.
    const lastTwoClicks = lastOfType('click', 2);
    if (lastTwoClicks.length === 2 && lastTwoClicks[0].args?.nodeId === lastTwoClicks[1].args?.nodeId) {
      warnings.push(`flow: your last two browser_act({action:"click"}) calls both targeted node ${args?.nodeId}. If the first click's snapshot showed no change, don't assume it silently failed and retry blind — the effect may just be slow to render; consider a brief pause or checking browser_inspect({action:"network_requests"}) before clicking again, since retrying a click that actually worked can double-submit.`);
    }
  }

  return warnings.length > 0 ? warnings.join(' | ') : undefined;
}

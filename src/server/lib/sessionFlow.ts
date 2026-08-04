// Tracks the recent command history for this daemon session and flags known
// bad patterns as they happen. `instructions` on the MCP server is only read
// once at initialize — by command #40 in a long session, a model has often
// drifted from it. This gives a live nudge exactly when the pattern recurs,
// which is a much stronger signal than a wall of text read once up front.

interface HistoryEntry {
  cmd: string;
  args: Record<string, unknown>;
}

const HISTORY_LIMIT = 15;
const history: HistoryEntry[] = [];
let snapshottedSinceNavigate = false;

const INTERACTION_LIKE_EVALUATE = /\.value\s*=|\.click\(\)|\.checked\s*=|dispatchEvent/;

// The last `count` occurrences of `cmd`, scanning the full retained history
// regardless of what's interleaved between them. Filtering-then-slicing
// (not slicing-then-filtering) matters: a click that got re-verified with a
// snapshot before being retried is still "the same click twice" — an
// unconditional-inactivity naive slice of the last N *entries* would miss it
// because the snapshot in between pushes the second click out of a small
// fixed-size window.
function lastOfType(cmd: string, count: number): HistoryEntry[] {
  return history.filter((h) => h.cmd === cmd).slice(-count);
}

export function recordAndCheckFlow(cmd: string, args: Record<string, unknown>): string | undefined {
  history.push({ cmd, args });
  while (history.length > HISTORY_LIMIT) history.shift();

  if (cmd === 'navigate') {
    snapshottedSinceNavigate = false;
    return undefined;
  }
  if (cmd === 'snapshot' || cmd === 'visual_snapshot' || cmd === 'query_region') {
    snapshottedSinceNavigate = true;
  }

  const warnings: string[] = [];

  if (cmd === 'evaluate' && typeof args?.expression === 'string' && INTERACTION_LIKE_EVALUATE.test(args.expression)) {
    const priorInteractionEvaluates = lastOfType('evaluate', 10)
      .filter((h) => typeof h.args?.expression === 'string' && INTERACTION_LIKE_EVALUATE.test(h.args.expression));
    if (priorInteractionEvaluates.length >= 2) {
      warnings.push(`flow: this is your ${priorInteractionEvaluates.length}th recent browser_evaluate call that looks like it's simulating a click/input (.value=, .click(), dispatchEvent). Switch to browser_click/browser_type — evaluate-set values don't reliably trigger React/Vue's real event handlers, so you may be testing something that doesn't work the way you think it does.`);
    }
  }

  if (cmd === 'screenshot' || cmd === 'visual_snapshot') {
    const count = lastOfType('screenshot', HISTORY_LIMIT).length + lastOfType('visual_snapshot', HISTORY_LIMIT).length;
    if (count >= 3) {
      warnings.push(`flow: you've captured ${count} screenshots in the last ${HISTORY_LIMIT} commands. Each one costs real tokens — prefer browser_snapshot (text-only) unless you specifically need to see layout/styling right now.`);
    }
  }

  if ((cmd === 'click' || cmd === 'type') && !snapshottedSinceNavigate) {
    warnings.push(`flow: acting on a node id with no snapshot/visual_snapshot/query_region call since the last navigate. If this id came from an old snapshot it may be stale — expect "Failed to resolve node bounds" if so.`);
  }

  if (cmd === 'click') {
    // Deliberately NOT scoped to "in a row" — the same nodeId showing up as
    // your last two clicks even with a snapshot in between is exactly the
    // "clicked, saw no change, clicked again" pattern, and it's real: one
    // observed case burned ~3000 tokens re-snapshotting an unchanged page
    // between two identical clicks before the second one finally landed.
    const lastTwoClicks = lastOfType('click', 2);
    if (lastTwoClicks.length === 2 && lastTwoClicks[0].args?.nodeId === lastTwoClicks[1].args?.nodeId) {
      warnings.push(`flow: your last two browser_click calls both targeted node ${args?.nodeId}. If the first click's snapshot showed no change, don't assume it silently failed and retry blind — the effect may just be slow to render; consider a brief pause or checking browser_network_requests before clicking again, since retrying a click that actually worked can double-submit.`);
    }
  }

  return warnings.length > 0 ? warnings.join(' | ') : undefined;
}

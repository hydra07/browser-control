import type { Protocol } from 'devtools-protocol';
import type { BrowserCommand, FlowStep } from '../shared/protocol.js';
import { waitForStableDom } from './lib/wait.js';
import { installDialogAutoHandler } from './lib/dialog.js';
import { installNetworkCollector, listNetworkRequests, getNetworkRequestDetail, clearNetworkRequests } from './lib/network.js';
import { sendCommand, errorMessage } from './lib/cdp.js';

const GROUP_NAME = '🤖 AI Workspace';
// Single source of truth is manifest.json — bump its "version" whenever
// background.ts changes, so a stale loaded extension is easy to spot instead
// of failing mysteriously with "Unknown command" on tools that exist in the
// source but were never reloaded into Chrome.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let activeTabId: number | null = null;
let isDebuggerAttached = false;

// Which tabs in the "🤖 AI Workspace" group browser_list_tabs has already
// reported — lets it flag tabs the user just dragged in as isNew:true
// without the AI having to remember what it saw last time itself. Reset
// (replaced, not merged) on every browser_list_tabs call to the current
// tab set, so a closed-then-reopened tab with a new id is treated as new
// again rather than leaking stale ids forever.
let seenTabIds = new Set<number>();
// Drives the toolbar badge — the human-visible half of the "user dropped a
// tab in" signal, since there's no way to push a live notification into
// the AI's own reasoning loop (MCP is pull-based; the AI only learns
// something when it calls a tool). Cleared when browser_list_tabs runs.
let unseenTabCount = 0;

// chrome.action requires "action" in manifest.json to exist at all — see
// the badge-clearing code in the 'list_tabs' dispatchCommand branch and the
// chrome.tabs.onUpdated listener below for where this is actually driven.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (changeInfo.groupId == null || changeInfo.groupId < 0) return;
  try {
    const group = await chrome.tabGroups.get(changeInfo.groupId);
    if (group.title !== GROUP_NAME) return;
  } catch {
    return;
  }
  unseenTabCount++;
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  chrome.action.setBadgeText({ text: String(unseenTabCount) });
});

type AXNode = Protocol.Accessibility.AXNode;
type SnapshotEntry = { i?: number; r?: string; n?: string; v?: string; children?: SnapshotEntry[] };

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'treeitem', 'tab', 'slider']);

function isMeaningfulAxNode(node: AXNode): boolean {
  const role = node.role?.value;
  if (!role) return false;
  // Keep interactive elements, but only if they resolve to a real DOM node —
  // otherwise click/type would receive an id they can never use.
  if (INTERACTIVE_ROLES.has(role)) return !!node.backendDOMNodeId;
  if (role === 'StaticText' || role === 'heading' || role === 'paragraph') {
    const text = node.name?.value?.trim();
    return !!text && text.length > 0;
  }
  return false;
}

// A button/link/heading's inner label commonly shows up a second time as a
// StaticText child with the exact same text (e.g. <button><span>詳細</span>
// </button> → button "詳細" AND StaticText "詳細"). The parent's own `name`
// already carries that text, so keeping the child too is pure duplication.
// childIds reference AXNode.nodeId (the AX-tree id), not backendDOMNodeId.
function computeRedundantTextAxIds(byAxId: Map<string, AXNode>, meaningfulAxIds: Set<string>): Set<string> {
  const redundant = new Set<string>();
  function mark(axId: string) {
    for (const childId of byAxId.get(axId)?.childIds ?? []) {
      if (redundant.has(childId)) continue;
      redundant.add(childId);
      mark(childId);
    }
  }
  for (const axId of meaningfulAxIds) {
    if (byAxId.get(axId)?.role?.value !== 'StaticText') mark(axId);
  }
  return redundant;
}

function toCompactEntry(node: AXNode): SnapshotEntry {
  return {
    // backendDOMNodeId (DOM domain), NOT nodeId (Accessibility-tree-only id).
    // click/type resolve elements via DOM.getBoxModel, which only accepts
    // the former; passing the latter silently targets the wrong element.
    // Keys are shortened (i/r/n/v) since this can run into the hundreds of
    // entries on data-heavy pages.
    i: node.backendDOMNodeId,
    r: node.role?.value,
    n: node.name?.value,
    ...(node.value?.value ? { v: String(node.value.value) } : {}),
  };
}

function buildSnapshotNodes(nodes: AXNode[]): SnapshotEntry[] {
  const kept = nodes.filter(isMeaningfulAxNode);
  const byAxId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));
  const redundantTextAxIds = computeRedundantTextAxIds(byAxId, new Set(kept.map((n) => n.nodeId)));

  return kept
    .filter((node) => node.role?.value !== 'StaticText' || !redundantTextAxIds.has(node.nodeId))
    .map(toCompactEntry);
}

// Unlike buildSnapshotNodes (flat list, whole page), this keeps parent-child
// nesting — a label's StaticText and its sibling input end up as entries in
// the SAME children array, so which label belongs to which field is visible
// from structure instead of having to guess from position in a flat list of
// hundreds. Only worth the extra shape for browser_query_region, where scope
// is already small (a form/panel), not for a full-page snapshot.
const MAX_REGION_NODES = 150;

function buildRegionTree(nodes: AXNode[]): { tree: SnapshotEntry[]; truncated: boolean } {
  if (nodes.length === 0) return { tree: [], truncated: false };

  const byAxId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));
  const meaningfulAxIds = new Set(nodes.filter(isMeaningfulAxNode).map((n) => n.nodeId));
  const redundantTextAxIds = computeRedundantTextAxIds(byAxId, meaningfulAxIds);
  let emitted = 0;
  let truncated = false;

  function buildChildren(axId: string): SnapshotEntry[] {
    const result: SnapshotEntry[] = [];
    for (const childId of byAxId.get(axId)?.childIds ?? []) {
      if (emitted >= MAX_REGION_NODES) {
        truncated = true;
        break;
      }
      const child = byAxId.get(childId);
      if (!child) continue;
      const childRole = child.role?.value;
      const isText = childRole === 'StaticText' || childRole === 'heading' || childRole === 'paragraph';
      if (isText && redundantTextAxIds.has(childId)) continue;

      if (meaningfulAxIds.has(childId)) {
        emitted++;
        const entry = toCompactEntry(child);
        const grandChildren = buildChildren(childId);
        if (grandChildren.length > 0) entry.children = grandChildren;
        result.push(entry);
      } else {
        // Not meaningful itself (a plain wrapper div, a <span> with no role,
        // etc.) — splice its meaningful descendants into this level instead
        // of adding a content-free nesting layer for every wrapper div.
        result.push(...buildChildren(childId));
      }
    }
    return result;
  }

  // The requested element is whichever returned node isn't referenced as
  // anyone else's child — more robust than assuming array order.
  const referencedAsChild = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) referencedAsChild.add(c);
  const root = nodes.find((n) => !referencedAsChild.has(n.nodeId)) ?? nodes[0];

  if (meaningfulAxIds.has(root.nodeId)) {
    const entry = toCompactEntry(root);
    const children = buildChildren(root.nodeId);
    if (children.length > 0) entry.children = children;
    return { tree: [entry], truncated };
  }
  return { tree: buildChildren(root.nodeId), truncated };
}

function countTreeNodes(entries: SnapshotEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    count += 1;
    if (entry.children) count += countTreeNodes(entry.children);
  }
  return count;
}

// Self-contained: gets serialized via .toString() and injected into the page,
// so it must not reference anything from the extension's closure — including
// each other or shared constants. Shared brand palette across every visual-
// feedback function below: indigo/violet for click, cyan/blue for type —
// consistent identity so a human watching can tell at a glance which kind of
// action just fired. Each function's small "inject my own @keyframes if
// missing" snippet is duplicated (not factored out) for the same reason:
// there's no shared JS scope across separately toString()'d functions, only
// string duplication survives serialization.
function drawAnnotationOverlay(boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
  const old = document.getElementById('__bc_annotate_overlay__');
  if (old) old.remove();
  if (!document.getElementById('__bc_annotate_style__')) {
    const style = document.createElement('style');
    style.id = '__bc_annotate_style__';
    style.textContent = '@keyframes __bc_pop__ { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }';
    document.documentElement.appendChild(style);
  }
  const container = document.createElement('div');
  container.id = '__bc_annotate_overlay__';
  container.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(container);
  boxes.forEach((b, idx) => {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:1.5px solid rgba(99,102,241,0.85);border-radius:6px;box-sizing:border-box;background:rgba(99,102,241,0.07);box-shadow:0 0 0 1px rgba(255,255,255,0.5) inset,0 2px 10px rgba(99,102,241,0.25);transform-origin:center;animation:__bc_pop__ 0.22s ease-out ${idx * 0.012}s both;`;
    const label = document.createElement('div');
    label.textContent = String(b.id);
    label.style.cssText = 'position:absolute;top:-10px;left:-10px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:linear-gradient(135deg,#a78bfa,#6366f1);color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;box-shadow:0 2px 6px rgba(99,102,241,0.5),0 0 0 2px #fff;';
    box.appendChild(label);
    container.appendChild(box);
  });
}

function quadToBox(quad: Protocol.DOM.Quad): { x: number; y: number; w: number; h: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Self-contained: injected via .toString(). Glides a visible cursor dot to
// (x, y) instead of teleporting the highlight straight there, so a human
// watching can actually track where the action is headed. Returns a Promise
// so the caller can await via Runtime.evaluate's awaitPromise, keeping the
// real click/type in sync with the animation instead of racing ahead of it.
// `fast` shortens the glide for run_flow/explore_flow steps (background.ts's
// pageDelay-based aim-pause is also skipped by callers in fast mode) so a
// multi-step script finishes well inside the daemon's fixed command timeout
// — same visual style, just compressed, not a different look.
function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
  return new Promise((resolve) => {
    // Diagnostic: open DevTools (F12) on the page itself and watch for this
    // — if it never appears, the injected code isn't running at all (page
    // JS error, CSP, or a debugger command failure upstream). If it DOES
    // appear but nothing is visible, the element is rendering but hidden —
    // most likely a page-level CSS ancestor with transform/filter/perspective,
    // which makes position:fixed descendants position relative to THAT
    // ancestor's box instead of the real viewport, not this code.
    console.log('[browsercontrol] moveCursorTo', x, y, fast);
    if (!document.getElementById('__bc_cursor_style__')) {
      const style = document.createElement('style');
      style.id = '__bc_cursor_style__';
      style.textContent = '@keyframes __bc_halo__ { 0%,100% { transform: scale(0.82); opacity: .55; } 50% { transform: scale(1.15); opacity: .9; } }';
      document.documentElement.appendChild(style);
    }
    const durationS = fast ? 0.22 : 0.85;
    // documentElement (<html>) instead of body: fewer real-world apps put a
    // transform/filter on <html> than on <body> or a layout wrapper div, so
    // appending here is less likely to get silently clipped/repositioned by
    // an ancestor's CSS.
    let cursor = document.getElementById('__bc_cursor__') as HTMLDivElement | null;
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__bc_cursor__';
      // A soft pulsing halo (signals "an AI is actively in control here")
      // behind a small solid gradient dot marking the exact point — glassy/
      // glowing rather than the old flat white-dot-with-black-border look.
      // The dot itself has its own transform transition so a press/release
      // squish (see pulseCursorPress) reads as a distinct, separate beat
      // from the glide.
      cursor.innerHTML =
        '<div style="position:absolute;left:0;top:0;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;background:radial-gradient(circle, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 72%);animation:__bc_halo__ 1.4s ease-in-out infinite;"></div>' +
        '<div data-bc-dot style="position:absolute;left:0;top:0;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#6366f1);box-shadow:0 0 0 3px rgba(255,255,255,0.95),0 3px 10px rgba(99,102,241,0.55);transition:transform 0.15s ease;"></div>';
      document.documentElement.appendChild(cursor);
    }
    // width/height 0 so children (positioned at left:0/top:0 with their own
    // negative margins) sit exactly on the point this transition drives —
    // only left/top need to animate, not each child separately. Slight
    // overshoot easing (back-out) reads as a more natural glide than linear/
    // ease — same idea as native OS pointer/spring animations. Set on every
    // call (not just creation) so a step can switch speed from the previous
    // one — e.g. a fast flow step followed by a normal standalone click.
    cursor.style.cssText = `all:initial;position:fixed;width:0;height:0;z-index:2147483647;pointer-events:none;left:${cursor.style.left || '-100px'};top:${cursor.style.top || '-100px'};transition:left ${durationS}s cubic-bezier(0.22,1,0.36,1),top ${durationS}s cubic-bezier(0.22,1,0.36,1);`;
    // Force a layout flush so the transition animates from the cursor's
    // current position instead of jumping straight to the new one.
    void cursor.offsetWidth;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    setTimeout(resolve, fast ? 260 : 900);
  });
}

// Self-contained: injected via .toString(). A quick squish-down/release on
// the cursor's inner dot, timed to real mousedown/mouseup — makes the
// moment of contact readable as its own beat instead of the ripple being
// the only signal that a click actually landed.
function pulseCursorPress(pressed: boolean) {
  const dot = document.querySelector('#__bc_cursor__ [data-bc-dot]') as HTMLElement | null;
  if (dot) dot.style.transform = pressed ? 'scale(0.65)' : 'scale(1)';
}

// Self-contained: injected via .toString(). A brief ripple at the exact
// point a click/type action landed — separate from the corner-bracket
// highlight (which marks the element), this marks the precise pixel the
// input event fired at, the same "tap feedback" pattern as native touch/
// click UIs. `kind` picks the brand color: violet for click, cyan for type,
// matching the accent used by the corresponding native CDP highlight. This
// is fire-and-forget (never awaited by callers) so it never affects how
// long a click/type/flow-step takes to resolve — `fast` only trims it down
// for a calmer look during run_flow/explore_flow, not for speed.
function showClickRipple(x: number, y: number, kind: 'click' | 'type', fast?: boolean) {
  console.log('[browsercontrol] showClickRipple', x, y, kind, fast);
  if (!document.getElementById('__bc_ripple_style__')) {
    const style = document.createElement('style');
    style.id = '__bc_ripple_style__';
    style.textContent = '@keyframes __bc_ring__ { 0% { transform: scale(0.35); opacity: .85; } 100% { transform: scale(1); opacity: 0; } }';
    document.documentElement.appendChild(style);
  }
  const [a, b] = kind === 'type' ? ['#22d3ee', '#3b82f6'] : ['#a78bfa', '#6366f1'];
  const wrap = document.createElement('div');
  wrap.style.cssText = `all:initial;position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:2147483647;pointer-events:none;`;
  document.documentElement.appendChild(wrap);
  // Two/three staggered rings expanding+fading, plus a small solid core —
  // reads as a richer "pulse" than a single flat circle growing and fading.
  const ringCount = fast ? 1 : 3;
  const ringDurationS = fast ? 0.4 : 0.9;
  for (let i = 0; i < ringCount; i++) {
    const ring = document.createElement('div');
    ring.style.cssText = `position:absolute;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid ${a};box-shadow:0 0 14px 1px ${b}55;opacity:0;animation:__bc_ring__ ${ringDurationS}s ease-out ${i * 0.18}s forwards;`;
    wrap.appendChild(ring);
  }
  const core = document.createElement('div');
  core.style.cssText = `position:absolute;left:0;top:0;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:linear-gradient(135deg,${a},${b});box-shadow:0 0 10px 3px ${b}aa;`;
  wrap.appendChild(core);
  setTimeout(() => wrap.remove(), fast ? 500 : 1300);
}

function removeAnnotationOverlay() {
  document.getElementById('__bc_annotate_overlay__')?.remove();
}

// Every visual-feedback injection (cursor/highlight/ripple/overlay) used to
// go through a bare chrome.debugger.sendCommand(..., resolve) that ignored
// the result entirely — if the injected code threw (or the command itself
// failed), we'd silently move on with no visual effect and zero trace of
// why. Route them all through here so failures show up in the extension's
// own service worker console (chrome://extensions → "service worker" link)
// instead of just quietly not happening.
function evalOnPage(target: chrome.debugger.Debuggee, expression: string, awaitPromise = false): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, awaitPromise }, (result) => {
      const evalResult = result as Protocol.Runtime.EvaluateResponse | undefined;
      if (chrome.runtime.lastError) {
        console.error('[browsercontrol] visual feedback command failed:', chrome.runtime.lastError.message);
      } else if (evalResult?.exceptionDetails) {
        console.error('[browsercontrol] visual feedback script threw:', evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails.text);
      }
      resolve();
    });
  });
}

// A bare `await new Promise(r => setTimeout(r, ms))` inside the service
// worker's own JS realm doesn't count as "pending work" to Chrome's MV3
// keep-alive heuristic — only in-flight chrome.* API calls do. A raw timer
// pause here risks the service worker being torn down mid-wait (silently
// dropping the whole dispatchCommand call, never resolving or rejecting,
// until the daemon's outer HTTP timeout finally gives up with no useful
// diagnostic). Routing the same delay through a real Runtime.evaluate
// round-trip — the same mechanism moveCursorTo already relies on — keeps it
// inside the "real CDP command in flight" category that's proven reliable
// throughout this codebase.
function pageDelay(target: chrome.debugger.Debuggee, ms: number): Promise<void> {
  return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

// backendDOMNodeId is only stable within one page's DOM — it's meaningless
// after a fresh navigate, which makes raw-id replay unreliable (see
// replay.ts). role+name (the same fields browser_snapshot returns) stay
// meaningful across a reload, since they reflect the page's actual visible
// content rather than an internal id Chrome happens to assign. Attaching
// them to every click/type response lets replay re-resolve "the button
// named X" against a fresh snapshot instead of trusting a stale id.
async function getAxInfoForNode(target: chrome.debugger.Debuggee, backendNodeId: number): Promise<{ role?: string; name?: string }> {
  const result = await sendCommand<Protocol.Accessibility.QueryAXTreeResponse>(target, 'Accessibility.queryAXTree', { backendNodeId });
  const node = result?.nodes?.[0];
  return { role: node?.role?.value, name: node?.name?.value };
}

// Native CDP highlight instead of injected DOM — drawn by Chrome's own
// inspector-overlay compositor layer (the same mechanism as DevTools'
// "Inspect Element" hover box), so it's rendered above the page entirely
// outside its DOM/CSS. Immune to whatever the page does with transforms,
// z-index, stacking contexts, or CSP — none of that applies here.
async function showNativeHighlight(
  target: chrome.debugger.Debuggee,
  box: { x: number; y: number; w: number; h: number },
  rgb: { r: number; g: number; b: number },
): Promise<void> {
  await sendCommand(target, 'Overlay.highlightRect', {
    x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h),
    color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.2 },
    outlineColor: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.9 },
  });
}

function hideNativeHighlight(target: chrome.debugger.Debuggee): void {
  chrome.debugger.sendCommand(target, 'Overlay.hideHighlight', {}, () => {});
}

// The WebSocket to the daemon lives in the offscreen document, not here —
// chrome.debugger (used by everything below) isn't available there, so the
// split is: offscreen holds the transport, the service worker does the CDP
// work, connected by chrome.runtime.sendMessage. This also sidesteps the old
// problem entirely: an offscreen document isn't killed after ~30s idle the
// way this service worker is, so the WS connection no longer needs a
// periodic alarm to notice and repair itself after Chrome suspends us.
// chrome.offscreen.createDocument's url resolves relative to the extension
// root (the directory containing manifest.json), NOT relative to this
// script's own location — so this must be the full path from the build
// output root, matching wherever tsc/copy:assets actually put offscreen.html.
const OFFSCREEN_DOCUMENT_PATH = 'dist/extension/offscreen.html';

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    // No Reason in the enum is a perfect fit for "hold a WebSocket" — WORKERS
    // is the closest justifiable one and, unlike AUDIO_PLAYBACK, has no
    // auto-close timer.
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Holds a persistent WebSocket connection to the local BrowserControl daemon. chrome.debugger is unavailable in offscreen documents, so this is transport only — the service worker still performs all CDP commands.',
  });
}

interface RelayMessage {
  target: 'background';
  payload: BrowserCommand & { id: string };
}

chrome.runtime.onMessage.addListener((message: RelayMessage, _sender, sendResponse) => {
  if (message?.target !== 'background') return;
  dispatchCommand(message.payload)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ error: errorMessage(e) }));
  return true; // keep the message channel open for the async response
});

installDialogAutoHandler();
installNetworkCollector(() => activeTabId);
ensureOffscreenDocument();
chrome.runtime.onStartup.addListener(ensureOffscreenDocument);

async function attachDebuggerIfNeeded(tabId: number) {
  if (!isDebuggerAttached) {
    await new Promise<void>((resolve) => {
      chrome.debugger.attach({ tabId }, '1.3', () => resolve());
    });
    isDebuggerAttached = true;
    // These domains are independent of each other — enabling them
    // concurrently costs ~1 round-trip instead of 5 sequential ones.
    // Page: lets us auto-handle dialogs. DOM: required by getBoxModel.
    // Network: request/response collection. CSS: matched/computed styles.
    // Overlay: native highlight rendering, immune to the page's own CSS.
    const target = { tabId };
    await Promise.all([
      sendCommand(target, 'Page.enable'),
      sendCommand(target, 'DOM.enable'),
      sendCommand(target, 'Network.enable'),
      sendCommand(target, 'CSS.enable'),
      sendCommand(target, 'Overlay.enable'),
    ]);
  }
}

const RELEVANT_STYLE_PROPS = new Set([
  'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'border', 'border-radius',
  'font-size', 'font-weight', 'line-height', 'opacity', 'visibility',
  'z-index', 'overflow', 'flex-direction', 'justify-content', 'align-items',
]);

// A CDP command that failed at the protocol level (not a chrome.debugger
// connection issue) — chrome.debugger's callback delivers these inline on
// the result object rather than via chrome.runtime.lastError.
type CdpResult<T> = T & { error?: { message: string } };

// Input.dispatchKeyEvent needs a real (key, code, Windows virtual key code)
// triple per key — there's no generic "just send Enter" shortcut in CDP.
// `text` is only set for keys that should also fire a synthesized `char`
// event (otherwise React/Vue's onKeyDown fires but no character is typed,
// which is correct for Enter/Tab/arrows/Escape but wrong for Space).
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

type AxInfo = { role?: string; name?: string };
type ActionResult = { success: true; message: string; role?: string; name?: string; _riskWarning?: string } | { error: string; hint?: string };

// Flags a target whose accessible name suggests a destructive/irreversible
// action. Standalone browser_click/browser_type attach this as a non-
// blocking `_riskWarning` (the AI was explicitly told to act on this one
// element, so it's advisory only); run_flow/explore_flow use it to BLOCK a
// step by default (see runFlowSteps) since those steps come from the AI's
// own guess at a flow rather than a direct instruction, and are exactly the
// case the guard is meant to catch.
const RISKY_NAME_PATTERN = /delete|remove|uninstall|deactivate|cancel|unsubscribe|sign\s*out|log\s*out|pay|purchase|confirm|permanently/i;

function isRiskyTarget(axInfo: AxInfo): boolean {
  return !!axInfo.name && RISKY_NAME_PATTERN.test(axInfo.name);
}

function withRiskWarning(result: ActionResult, axInfo: AxInfo, verb: string): ActionResult {
  if ('success' in result && isRiskyTarget(axInfo)) {
    result._riskWarning = `This ${verb} ${axInfo.role ?? 'element'} "${axInfo.name}", which looks potentially destructive/irreversible.`;
  }
  return result;
}

// The shared implementation behind both the standalone `click` command and
// run_flow/explore_flow's 'click' steps — `opts.fast` trims the animation
// (shorter cursor glide, no aim-pause, shorter ripple/highlight) so a
// multi-step flow finishes well inside the daemon's fixed command timeout,
// without changing the standalone command's current (slower, more
// demoable) timing at all.
async function performClick(target: chrome.debugger.Debuggee, backendNodeId: number, opts: { fast: boolean }): Promise<ActionResult> {
  // getBoxModel returns coordinates relative to the CURRENT viewport. If the
  // element is scrolled out of view, those coordinates land outside the
  // visible area — the click misses (or hits whatever else is there) and
  // the cursor/highlight animate somewhere invisible.
  await sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const boxModel = await sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId });
  if (!boxModel?.model) {
    return { error: "Failed to resolve node bounds", hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry." };
  }
  const box = quadToBox(boxModel.model.content);
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;

  // Glide the cursor there first, then highlight — visible movement instead
  // of a highlight teleporting straight to the target. Fetch role/name
  // concurrently — independent of the animation, needed for replay to
  // re-resolve this element by identity instead of stale id.
  const [, axInfo] = await Promise.all([
    evalOnPage(target, `(${moveCursorTo.toString()})(${x}, ${y}, ${opts.fast})`, true),
    getAxInfoForNode(target, backendNodeId),
  ]);
  await showNativeHighlight(target, box, { r: 99, g: 102, b: 241 });
  // Brief "aim" pause with the cursor arrived and the target highlighted but
  // before anything fires — without this the glide finishing and the actual
  // click were visually simultaneous, reading as one instant blip instead of
  // separate, followable steps. Skipped in fast mode.
  if (!opts.fast) await pageDelay(target, 350);

  // Dispatch mousedown and mouseup, with a visible press/release squish on
  // the cursor dot so the moment of contact is its own beat.
  void evalOnPage(target, `(${pulseCursorPress.toString()})(true)`);
  await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  void evalOnPage(target, `(${showClickRipple.toString()})(${x}, ${y}, 'click', ${opts.fast})`);
  if (!opts.fast) await pageDelay(target, 130);
  void evalOnPage(target, `(${pulseCursorPress.toString()})(false)`);
  await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await waitForStableDom(target);
  // Hold the highlight visible for a beat after the click lands instead of
  // snapping it away the instant the DOM settles — gives the eye time to
  // register "this is what got clicked" before it disappears.
  setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);

  return withRiskWarning({ success: true, message: `Clicked at (${x}, ${y})`, role: axInfo.role, name: axInfo.name }, axInfo, 'clicked');
}

// Shared implementation behind `type` and flow 'type' steps. `backendNodeId`
// is optional — without one this relies on something already being focused
// (e.g. right after a click), matching the standalone command's behavior.
async function performType(target: chrome.debugger.Debuggee, backendNodeId: number | undefined, text: string, opts: { fast: boolean }): Promise<ActionResult> {
  let axInfo: AxInfo = {};
  if (backendNodeId != null) {
    await sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });

    const focusResult = await sendCommand<CdpResult<{}>>(target, 'DOM.focus', { backendNodeId });
    if (focusResult?.error) {
      return { error: `Failed to focus node: ${focusResult.error.message}`, hint: "The node id may be stale, or the element isn't focusable (e.g. a div, not an input). Take a fresh snapshot and confirm it's an input/textbox node." };
    }

    const [boxModel, resolvedAxInfo] = await Promise.all([
      sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId }),
      getAxInfoForNode(target, backendNodeId),
    ]);
    axInfo = resolvedAxInfo;
    if (boxModel?.model?.content) {
      const box = quadToBox(boxModel.model.content);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      await evalOnPage(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
      await showNativeHighlight(target, box, { r: 6, g: 182, b: 212 });
      // Same "arrived, about to act" beat as click — see the comment there.
      if (!opts.fast) await pageDelay(target, 350);
      void evalOnPage(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
      setTimeout(() => hideNativeHighlight(target), opts.fast ? 350 : 1200);
    }
  }

  // Input.insertText types into whichever element currently has focus, so
  // focusing first (above) is required. Outside fast mode, typed one
  // character at a time rather than as one bulk insertText call, so it
  // reads as an actual typing motion instead of the whole string just
  // appearing at once — Array.from (not a plain index loop) so multi-byte
  // characters aren't split across surrogate pairs, and the per-character
  // delay shrinks for longer strings so a whole paragraph doesn't turn into
  // a multi-second wait. Fast mode (flow steps) skips the per-character
  // animation entirely and inserts the whole string in one call — flow
  // steps favor throughput over the typing demo.
  if (opts.fast) {
    await sendCommand(target, 'Input.insertText', { text });
  } else {
    const chars = Array.from(text);
    const perCharDelayMs = chars.length > 40 ? 15 : 35;
    for (const ch of chars) {
      await sendCommand(target, 'Input.insertText', { text: ch });
      if (perCharDelayMs > 0) await pageDelay(target, perCharDelayMs);
    }
  }
  await waitForStableDom(target);

  return withRiskWarning({ success: true, message: `Typed "${text}"`, role: axInfo.role, name: axInfo.name }, axInfo, 'typed into');
}

// Shared implementation behind `press_key` and flow 'press_key' steps.
async function performPressKey(target: chrome.debugger.Debuggee, key: string, backendNodeId: number | undefined, opts: { fast: boolean }): Promise<ActionResult> {
  const def = KEY_DEFS[key];
  if (!def) return { error: `Unsupported key: "${key}"`, hint: `Supported keys: ${Object.keys(KEY_DEFS).join(', ')}.` };

  let axInfo: AxInfo = {};
  if (backendNodeId != null) {
    await sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const focusResult = await sendCommand<CdpResult<{}>>(target, 'DOM.focus', { backendNodeId });
    if (focusResult?.error) {
      return { error: `Failed to focus node: ${focusResult.error.message}`, hint: "The node id may be stale, or the element isn't focusable. Take a fresh snapshot and retry." };
    }
    const [boxModel, resolvedAxInfo] = await Promise.all([
      sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId }),
      getAxInfoForNode(target, backendNodeId),
    ]);
    axInfo = resolvedAxInfo;
    if (boxModel?.model?.content) {
      const box = quadToBox(boxModel.model.content);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      await evalOnPage(target, `(${moveCursorTo.toString()})(${cx}, ${cy}, ${opts.fast})`, true);
      await showNativeHighlight(target, box, { r: 6, g: 182, b: 212 });
      if (!opts.fast) await pageDelay(target, 250);
      void evalOnPage(target, `(${showClickRipple.toString()})(${cx}, ${cy}, 'type', ${opts.fast})`);
      setTimeout(() => hideNativeHighlight(target), opts.fast ? 300 : 900);
    }
  }

  // rawKeyDown+keyUp always fire; the synthesized `char` event in between is
  // what actually inserts a character for keys like Space — Enter/Tab/
  // arrows/Escape have no `text` and so only fire key events, matching a
  // real browser's behavior for non-printing keys.
  await sendCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, key: def.key, code: def.code });
  if (def.text) {
    await sendCommand(target, 'Input.dispatchKeyEvent', { type: 'char', text: def.text, unmodifiedText: def.text });
  }
  await sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, key: def.key, code: def.code });
  await waitForStableDom(target);
  return { success: true, message: `Pressed ${key}`, role: axInfo.role, name: axInfo.name };
}

type ResolvedStepTarget = {
  backendNodeId: number;
  matched: { role?: string; name?: string } | { selector: string };
  // Always populated regardless of how the step matched (role+name directly,
  // or a selector followed by an AX lookup) so isRiskyTarget has one
  // consistent shape to check, instead of a selector match having no name.
  axInfo: AxInfo;
  ambiguous?: boolean;
}

// Resolves a flow step's target against the LIVE page at execution time —
// never a nodeId, since a script is written before the steps that create
// later DOM state have even run. role+name matching mirrors what
// replay.ts's resolveNodeIdByIdentity already does server-side (role/name
// survive a DOM re-render the way a backendDOMNodeId never does); doing it
// here instead means a flow doesn't pay a round trip per step to resolve.
async function resolveStepTarget(target: chrome.debugger.Debuggee, step: FlowStep): Promise<ResolvedStepTarget | null> {
  if (step.selector) {
    const docResult = await sendCommand<Protocol.DOM.GetDocumentResponse>(target, 'DOM.getDocument', { depth: 0 });
    const rootNodeId = docResult?.root?.nodeId;
    if (!rootNodeId) return null;
    const queryResult = await sendCommand<Protocol.DOM.QuerySelectorResponse>(target, 'DOM.querySelector', { nodeId: rootNodeId, selector: step.selector });
    if (!queryResult?.nodeId) return null;
    const describeResult = await sendCommand<Protocol.DOM.DescribeNodeResponse>(target, 'DOM.describeNode', { nodeId: queryResult.nodeId });
    const backendNodeId = describeResult?.node?.backendNodeId;
    if (!backendNodeId) return null;
    const axInfo = await getAxInfoForNode(target, backendNodeId);
    return { backendNodeId, matched: { selector: step.selector }, axInfo };
  }
  if (step.role && step.name) {
    const axTreeResult = await sendCommand<Protocol.Accessibility.GetFullAXTreeResponse>(target, 'Accessibility.getFullAXTree', {});
    const nodes = axTreeResult?.nodes || [];
    const candidates = nodes.filter((n) => n.role?.value === step.role && n.name?.value === step.name && n.backendDOMNodeId != null);
    if (candidates.length === 0) return null;
    return {
      backendNodeId: candidates[0].backendDOMNodeId!,
      matched: { role: step.role, name: step.name },
      axInfo: { role: step.role, name: step.name },
      ambiguous: candidates.length > 1,
    };
  }
  return null;
}

function describeStepTarget(step: FlowStep): string {
  if (step.selector) return `selector "${step.selector}"`;
  if (step.role || step.name) return `${step.role ?? 'element'} "${step.name ?? ''}"`;
  return 'the currently focused element';
}

type SnapshotDelta = {
  added: SnapshotEntry[];
  changed: SnapshotEntry[];
  removed: Array<{ role?: string; name?: string }>;
  truncated?: boolean;
};

type FlowStepResult = {
  index: number;
  action: string;
  matched?: { role?: string; name?: string } | { selector: string };
  ambiguous?: boolean;
  success: boolean;
  error?: string;
  delta?: SnapshotDelta;
}

type FlowReport = {
  success: boolean;
  stoppedAtStep?: number;
  reason?: 'too_many_steps' | 'not_found' | 'risky_action_blocked' | 'action_failed' | 'assert_failed' | 'timeout';
  message?: string;
  steps: FlowStepResult[];
  finalSnapshot?: SnapshotEntry[];
}

const MAX_FLOW_STEPS = 20;
const WAIT_FOR_POLL_MS = 250;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 3000;
// Real-world measurement (a 10-call explore_flow session against a
// data-heavy admin list/search screen): returning a FULL page snapshot
// after every step cost 87k+ tokens on its own — 77% of that session's
// entire tool-call token spend, escalating up to ~28k tokens for a single
// call as the page accumulated more rows. Most of that was the SAME static
// content (nav, sidebar, footer, unrelated rows) re-emitted on every step.
// A diff against the previous step — what's new, changed, or gone — is
// both smaller AND more directly useful (it answers "what did this step
// actually do?" instead of making the caller re-diff two huge snapshots
// themselves), capped defensively in case a single step still changes an
// unusually large number of elements (e.g. a big table re-rendering).
const MAX_DELTA_ENTRIES = 30;

async function takeFlowSnapshot(target: chrome.debugger.Debuggee): Promise<SnapshotEntry[]> {
  const axTreeResult = await sendCommand<Protocol.Accessibility.GetFullAXTreeResponse>(target, 'Accessibility.getFullAXTree', {});
  return buildSnapshotNodes(axTreeResult?.nodes || []);
}

function snapshotEntryKey(e: SnapshotEntry): string {
  return `${e.r ?? ''}::${e.n ?? ''}`;
}

// Compares two flat snapshots by role+name identity (the same identity
// basis replay.ts and resolveStepTarget already use, since backendDOMNodeId
// isn't stable across a re-render). `prev` undefined (the very first step)
// reports everything present as "added" — there's nothing to diff against.
function diffSnapshots(prev: SnapshotEntry[] | undefined, curr: SnapshotEntry[]): SnapshotDelta {
  const prevMap = new Map((prev ?? []).map((e) => [snapshotEntryKey(e), e]));
  const currMap = new Map(curr.map((e) => [snapshotEntryKey(e), e]));

  const added: SnapshotEntry[] = [];
  const changed: SnapshotEntry[] = [];
  for (const [key, entry] of currMap) {
    const prevEntry = prevMap.get(key);
    if (!prevEntry) added.push(entry);
    else if (prevEntry.v !== entry.v) changed.push(entry);
  }
  const removed: Array<{ role?: string; name?: string }> = [];
  for (const [key, entry] of prevMap) {
    if (!currMap.has(key)) removed.push({ role: entry.r, name: entry.n });
  }

  const truncated = added.length > MAX_DELTA_ENTRIES || changed.length > MAX_DELTA_ENTRIES || removed.length > MAX_DELTA_ENTRIES;
  return {
    added: added.slice(0, MAX_DELTA_ENTRIES),
    changed: changed.slice(0, MAX_DELTA_ENTRIES),
    removed: removed.slice(0, MAX_DELTA_ENTRIES),
    ...(truncated ? { truncated: true } : {}),
  };
}

// The shared engine behind run_flow (opts.captureEachStep: false — one
// compact report + a final snapshot) and explore_flow (opts.captureEachStep:
// true — a snapshot after every step, for validating a best-guess sequence
// before committing to the leaner run_flow). Both have REAL side effects —
// there's no way to preview a later step's UI without actually executing
// the earlier ones (submitting a form, following a link) — explore_flow
// just reports more about what happened.
//
// Stops at the first step that doesn't resolve, fails, or is blocked as
// risky — deliberately no partial-credit "keep going and see" behavior,
// since a script auto-generated from a snapshot is exactly the kind of
// "blind" probing that should stop and report rather than compound a wrong
// guess into several more wrong actions.
async function runFlowSteps(target: chrome.debugger.Debuggee, steps: FlowStep[], opts: { captureEachStep: boolean }): Promise<FlowReport> {
  if (steps.length > MAX_FLOW_STEPS) {
    return { success: false, reason: 'too_many_steps', message: `Flow has ${steps.length} steps; max is ${MAX_FLOW_STEPS} per call. Split into multiple browser_run_flow/browser_explore_flow calls.`, steps: [] };
  }

  const results: FlowStepResult[] = [];

  const stop = (index: number, reason: FlowReport['reason'], message: string): FlowReport =>
    ({ success: false, stoppedAtStep: index, reason, message, steps: results });

  // Baseline to diff step 0 against — without this, step 0's delta would
  // report the ENTIRE page as "added" (nothing came before it), which is
  // exactly the full-snapshot cost this diffing exists to avoid.
  let previousSnapshot: SnapshotEntry[] | undefined;
  if (opts.captureEachStep) previousSnapshot = await takeFlowSnapshot(target);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const needsTarget = step.action !== 'scroll' && !(step.action === 'press_key' && !step.role && !step.selector);

    let resolved: ResolvedStepTarget | null = null;

    if (needsTarget) {
      if (step.action === 'wait_for') {
        const timeoutMs = step.timeoutMs ?? WAIT_FOR_DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        do {
          resolved = await resolveStepTarget(target, step);
          if (resolved || Date.now() >= deadline) break;
          await pageDelay(target, WAIT_FOR_POLL_MS);
        } while (true);
        if (!resolved) {
          results.push({ index: i, action: step.action, success: false, error: `Timed out after ${timeoutMs}ms` });
          return stop(i, 'timeout', `Step ${i} (wait_for) timed out after ${timeoutMs}ms waiting for ${describeStepTarget(step)}.`);
        }
      } else {
        resolved = await resolveStepTarget(target, step);
        if (!resolved) {
          results.push({ index: i, action: step.action, success: false, error: 'not_found' });
          return stop(i, 'not_found', `Step ${i} (${step.action}) found no element matching ${describeStepTarget(step)}. Stopped before continuing — take a fresh browser_snapshot/browser_explore_flow and correct this step.`);
        }
      }

      if (isRiskyTarget(resolved.axInfo) && !step.confirmRisky) {
        results.push({ index: i, action: step.action, matched: resolved.matched, ambiguous: resolved.ambiguous, success: false, error: 'risky_action_blocked' });
        return stop(i, 'risky_action_blocked', `Step ${i} (${step.action}) targets ${describeStepTarget(step)} (${resolved.axInfo.role ?? 'element'} "${resolved.axInfo.name ?? ''}"), which looks potentially destructive/irreversible. Confirm this is intended with your user, then re-run with steps[${i}].confirmRisky:true.`);
      }
    }

    let actionResult: ActionResult;
    switch (step.action) {
      case 'click':
        actionResult = await performClick(target, resolved!.backendNodeId, { fast: true });
        break;
      case 'type':
        actionResult = await performType(target, resolved?.backendNodeId, step.text ?? '', { fast: true });
        break;
      case 'press_key':
        actionResult = await performPressKey(target, step.key ?? '', resolved?.backendNodeId, { fast: true });
        break;
      case 'scroll': {
        const deltaX = step.deltaX || 0;
        const deltaY = step.deltaY || 0;
        await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 500, deltaX, deltaY });
        await waitForStableDom(target);
        actionResult = { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
        break;
      }
      case 'wait_for':
        actionResult = { success: true, message: `Found ${describeStepTarget(step)}` };
        break;
      case 'assert_text': {
        const text = resolved!.axInfo.name ?? '';
        actionResult = step.contains && text.includes(step.contains)
          ? { success: true, message: `"${step.contains}" found in "${text}"` }
          : { error: `Expected text containing "${step.contains ?? ''}", found "${text}"` };
        break;
      }
    }

    const success = 'success' in actionResult;
    const errorMessage = 'error' in actionResult ? actionResult.error : undefined;
    results.push({
      index: i,
      action: step.action,
      matched: resolved?.matched,
      ambiguous: resolved?.ambiguous,
      success,
      error: errorMessage,
    });
    if (opts.captureEachStep) {
      // What changed as a result of THIS step, not a full re-dump of the
      // page — the same content (nav, sidebar, unrelated rows) doesn't need
      // to be re-sent every step just because a handful of things moved.
      const currentSnapshot = await takeFlowSnapshot(target);
      results[results.length - 1].delta = diffSnapshots(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;
    }

    if (!success) {
      return stop(i, step.action === 'assert_text' ? 'assert_failed' : 'action_failed', `Step ${i} (${step.action}) failed: ${errorMessage}`);
    }
  }

  // Reuse the last step's already-captured snapshot instead of a redundant
  // extra AX-tree fetch when explore_flow already has it fresh.
  const finalSnapshot = opts.captureEachStep && previousSnapshot ? previousSnapshot : await takeFlowSnapshot(target);
  return { success: true, steps: results, finalSnapshot };
}

async function dispatchCommand(data: BrowserCommand & { id?: string }): Promise<Record<string, unknown>> {
  const cmd = data.cmd;

  // 1. Session Initialization (navigate)
  if (cmd === 'navigate') {
    return await handleNavigate(data.url);
  }

  // 1b. list_tabs / switch_tab: the "🤖 AI Workspace" tab group as a shared
  // handoff surface — the user drags tabs into it, the AI discovers them
  // here instead of only ever seeing the one tab it navigated to itself.
  // Neither needs an active CDP session (they're chrome.tabs/chrome.tabGroups
  // queries, not CDP), and both must work even before any navigate has
  // happened — a user might create the group and drop tabs in first, then
  // ask the AI to look. So both run here, before the activeTabId guard.
  if (cmd === 'list_tabs') {
    const groups = await chrome.tabGroups.query({ title: GROUP_NAME });
    if (groups.length === 0) return { tabs: [] };
    const tabs = await chrome.tabs.query({ groupId: groups[0].id });
    const result = tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        tabId: t.id!,
        url: t.url,
        title: t.title,
        active: t.id === activeTabId,
        isNew: !seenTabIds.has(t.id!),
      }));
    // Replaced (not merged) so a closed tab's id doesn't linger forever,
    // and cleared every call so the badge/isNew signal never re-fires for
    // the same tab twice.
    seenTabIds = new Set(result.map((t) => t.tabId));
    unseenTabCount = 0;
    chrome.action.setBadgeText({ text: '' });
    return { tabs: result };
  }

  if (cmd === 'switch_tab') {
    try {
      await chrome.tabs.get(data.tabId);
    } catch {
      return { error: `No tab with id ${data.tabId}`, hint: "Call browser_list_tabs again — it may have been closed." };
    }
    // isDebuggerAttached is a single global flag, not per-tab — it was safe
    // as long as handleNavigate was the only way to change activeTabId
    // (and it already resets this flag on stale-tab recovery). Switching to
    // a DIFFERENT valid tab is a second way that flag can go stale: leave it
    // true and attachDebuggerIfNeeded would skip attaching to the new tab
    // entirely, since it thinks a debugger is already attached (to the old
    // one). Detach from the old tab and reset so the next command properly
    // attaches CDP to the tab we're actually switching to.
    if (activeTabId && activeTabId !== data.tabId && isDebuggerAttached) {
      try { await chrome.debugger.detach({ tabId: activeTabId }); } catch {}
    }
    activeTabId = data.tabId;
    isDebuggerAttached = false;
    const tab = await chrome.tabs.update(data.tabId, { active: true });
    if (tab?.windowId != null) {
      chrome.windows.update(tab.windowId, { focused: true }, () => {
        if (chrome.runtime.lastError) console.log('Could not focus window:', chrome.runtime.lastError.message);
      });
    }
    return { success: true, message: `Switched to tab ${data.tabId}`, url: tab?.url, title: tab?.title };
  }

  // Ensure we have an active session
  if (!activeTabId) {
    return { error: 'No active session. Call navigate first.' };
  }

  // Attach debugger if needed
  await attachDebuggerIfNeeded(activeTabId);

  const target = { tabId: activeTabId };

  // 2. Snapshot
  if (cmd === 'snapshot') {
    const axTreeResult = await sendCommand<Protocol.Accessibility.GetFullAXTreeResponse>(target, 'Accessibility.getFullAXTree', {});

    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);

    return {
      message: "Extracted and Filtered Accessibility Tree",
      totalRawNodes: nodes.length,
      filteredNodesCount: filteredNodes.length,
      nodes: filteredNodes
    };
  }

  // 2c. Query region: scoped snapshot of just the subtree under a CSS
  // selector — the middle tier between whole-page snapshot (broad, noisy)
  // and inspect_element (one node, no surrounding structure). Useful for
  // seeing which label sits next to which field: the same flat id/role/name
  // list as snapshot, but small enough that adjacency alone tells you that.
  if (cmd === 'query_region') {
    if (!data.selector) return { error: "Missing selector", hint: "Pass a CSS selector for the container to scope into, e.g. 'form' or '.search-panel'." };

    const docResult = await sendCommand<Protocol.DOM.GetDocumentResponse>(target, 'DOM.getDocument', { depth: 0 });
    const rootNodeId = docResult?.root?.nodeId;
    if (!rootNodeId) return { error: "Failed to get document root", hint: "The page may still be loading; try again." };

    const queryResult = await sendCommand<Protocol.DOM.QuerySelectorResponse>(target, 'DOM.querySelector', { nodeId: rootNodeId, selector: data.selector });
    if (!queryResult?.nodeId) {
      return { error: `No element matched selector "${data.selector}"`, hint: "Check the selector against the page source, or use browser_snapshot first to find a container to scope into." };
    }

    const describeResult = await sendCommand<Protocol.DOM.DescribeNodeResponse>(target, 'DOM.describeNode', { nodeId: queryResult.nodeId });
    const backendNodeId = describeResult?.node?.backendNodeId;
    if (!backendNodeId) {
      return { error: "Failed to resolve matched element", hint: "Try a more specific selector." };
    }

    const axResult = await sendCommand<Protocol.Accessibility.GetPartialAXTreeResponse>(target, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const { tree, truncated } = buildRegionTree(axResult?.nodes || []);
    const nodeCount = countTreeNodes(tree);

    return {
      message: `Scoped to "${data.selector}" (${describeResult.node.nodeName}): ${nodeCount} element(s), nested by DOM structure — a field's label is its sibling in the same "children" array.${truncated ? ` Truncated at ${MAX_REGION_NODES} elements; use a narrower selector to see the rest.` : ''} Use these ids with browser_click/browser_type/browser_inspect_element.`,
      selector: data.selector,
      truncated,
      tree,
    };
  }

  // 2b. Visual snapshot: same as snapshot, plus a screenshot with numbered
  // boxes drawn over every interactive element so an id can be grounded to a
  // position on screen before clicking, instead of guessing from text alone.
  if (cmd === 'visual_snapshot') {
    const axTreeResult = await sendCommand<Protocol.Accessibility.GetFullAXTreeResponse>(target, 'Accessibility.getFullAXTree', {});
    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);

    const MAX_ANNOTATED = 40;
    const toAnnotate = filteredNodes.filter((n) => n.i != null).slice(0, MAX_ANNOTATED);

    const boxes: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
    await Promise.all(toAnnotate.map(async (node) => {
      const boxModel = await sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId: node.i });
      const quad = boxModel?.model?.content;
      if (quad) {
        const box = quadToBox(quad);
        if (box.w > 0 && box.h > 0) boxes.push({ id: node.i!, ...box });
      }
    }));

    await evalOnPage(target, `(${drawAnnotationOverlay.toString()})(${JSON.stringify(boxes)})`);

    const shot = await sendCommand<Protocol.Page.CaptureScreenshotResponse>(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });

    await evalOnPage(target, `(${removeAnnotationOverlay.toString()})()`);

    if (!shot?.data) {
      return { error: 'Failed to capture annotated screenshot', hint: 'The page or debugger session may be in a bad state; try navigating again.' };
    }

    return {
      message: `Annotated ${boxes.length} interactive element(s) on screen. Each numbered box in the screenshot is a node id you can pass to browser_click/browser_type.`,
      nodes: filteredNodes,
      format: 'jpeg',
      dataBase64: shot.data,
    };
  }

  // 3. Click (by nodeId)
  if (cmd === 'click') {
    if (!data.nodeId) return { error: "Missing nodeId", hint: "Call snapshot first and pass one of the returned node ids." };
    return await performClick(target, data.nodeId, { fast: false });
  }

  // 4. Type (focus + insertText)
  if (cmd === 'type') {
    if (!data.text) return { error: "Missing text" };
    return await performType(target, data.nodeId, data.text, { fast: false });
  }

  // 4b. Press a single named key (Enter to submit a search/form, Tab, Escape,
  // arrows, ...) — separate from `type`, which only inserts text and never
  // synthesizes a keypress, so a search box filled via `type` never submits
  // on its own the way a real user's Enter would.
  if (cmd === 'press_key') {
    return await performPressKey(target, data.key, data.nodeId, { fast: false });
  }

  // 4c. Batch flow scripting: run a list of steps (click/type/press_key/
  // wait_for/assert_text/scroll) in one call instead of one round trip per
  // step. run_flow returns a compact report + final snapshot; explore_flow
  // (same engine) returns a snapshot after every step, meant to be used
  // once to validate a best-guess flow before committing to the leaner
  // run_flow for repeat runs. Both stop at the first step that doesn't
  // resolve/succeed, or is blocked as looking risky — see runFlowSteps.
  if (cmd === 'run_flow' || cmd === 'explore_flow') {
    if (!Array.isArray(data.steps) || data.steps.length === 0) {
      return { error: "Missing steps", hint: "Pass a non-empty array of flow steps, e.g. [{action:'click', role:'button', name:'Login'}]." };
    }
    return await runFlowSteps(target, data.steps, { captureEachStep: cmd === 'explore_flow' });
  }

  // 5. Scroll
  if (cmd === 'scroll') {
    const deltaX = data.deltaX || 0;
    const deltaY = data.deltaY || 0;
    // Note: scroll needs x,y coordinates to apply the wheel event. We just use center screen.
    await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 500, deltaX, deltaY });
    await waitForStableDom(target);
    return { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
  }

  // 6. Screenshot
  if (cmd === 'screenshot') {
    const format = data.format === 'png' ? 'png' : 'jpeg';
    const params: Protocol.Page.CaptureScreenshotRequest = { format };
    if (format === 'jpeg') params.quality = data.quality ?? 80;

    if (data.fullPage) {
      const metrics = await sendCommand<Protocol.Page.GetLayoutMetricsResponse>(target, 'Page.getLayoutMetrics', {});
      const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
      if (contentSize) {
        params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }

    const res = await sendCommand<Protocol.Page.CaptureScreenshotResponse>(target, 'Page.captureScreenshot', params);
    if (!res?.data) {
      return { error: 'Failed to capture screenshot', hint: 'The page or debugger session may be in a bad state; try navigating again.' };
    }
    return { success: true, format, dataBase64: res.data };
  }

  // 7. Inspect element (style + logic detail for ONE node, on demand)
  if (cmd === 'inspect_element') {
    if (!data.nodeId) return { error: "Missing nodeId", hint: "Call snapshot or visual_snapshot first and pass one of the returned node ids." };
    const backendNodeId = data.nodeId;

    // Wave 1: these 4 calls only need backendNodeId, so they're independent
    // of each other — run concurrently instead of paying for 4 sequential
    // round-trips.
    const [describeResult, outerHTMLResult, pushResult, resolveResult] = await Promise.all([
      sendCommand<CdpResult<Protocol.DOM.DescribeNodeResponse>>(target, 'DOM.describeNode', { backendNodeId }),
      sendCommand<Protocol.DOM.GetOuterHTMLResponse>(target, 'DOM.getOuterHTML', { backendNodeId }),
      sendCommand<Protocol.DOM.PushNodesByBackendIdsToFrontendResponse>(target, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] }),
      sendCommand<Protocol.DOM.ResolveNodeResponse>(target, 'DOM.resolveNode', { backendNodeId }),
    ]);

    if (describeResult?.error || !describeResult?.node) {
      return { error: 'Failed to resolve node', hint: 'The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry.' };
    }

    let outerHTML: string | undefined = outerHTMLResult?.outerHTML;
    let outerHTMLTruncated = false;
    const MAX_HTML_CHARS = 5000;
    if (typeof outerHTML === 'string' && outerHTML.length > MAX_HTML_CHARS) {
      outerHTML = outerHTML.slice(0, MAX_HTML_CHARS);
      outerHTMLTruncated = true;
    }

    // CSS domain methods need a session-scoped nodeId (from wave 1's push),
    // not backendNodeId. DOMDebugger needs the objectId from resolveNode.
    // These 3 are independent of each other too — wave 2.
    const nodeId = pushResult?.nodeIds?.[0];
    const objectId = resolveResult?.object?.objectId;

    const [matchedResult, computedResult, listenersResult] = await Promise.all([
      nodeId != null ? sendCommand<Protocol.CSS.GetMatchedStylesForNodeResponse>(target, 'CSS.getMatchedStylesForNode', { nodeId }) : Promise.resolve(null),
      nodeId != null ? sendCommand<Protocol.CSS.GetComputedStyleForNodeResponse>(target, 'CSS.getComputedStyleForNode', { nodeId }) : Promise.resolve(null),
      objectId ? sendCommand<Protocol.DOMDebugger.GetEventListenersResponse>(target, 'DOMDebugger.getEventListeners', { objectId }) : Promise.resolve(null),
    ]);

    const matchedRules = (matchedResult?.matchedCSSRules || []).slice(0, 15).map((m) => ({
      selector: m.rule?.selectorList?.text,
      origin: m.rule?.origin,
      properties: Object.fromEntries(
        (m.rule?.style?.cssProperties || [])
          .filter((p) => !p.disabled)
          .map((p) => [p.name, p.value]),
      ),
    }));

    const computedStyle: Record<string, string> = {};
    for (const prop of computedResult?.computedStyle || []) {
      if (RELEVANT_STYLE_PROPS.has(prop.name)) computedStyle[prop.name] = prop.value;
    }

    const eventListeners = (listenersResult?.listeners || []).map((l) => ({
      type: l.type,
      useCapture: l.useCapture,
      passive: l.passive,
      once: l.once,
    }));
    if (objectId) chrome.debugger.sendCommand(target, 'Runtime.releaseObject', { objectId }, () => {});

    return {
      nodeName: describeResult.node.nodeName,
      attributes: describeResult.node.attributes,
      outerHTML,
      outerHTMLTruncated,
      matchedRules,
      computedStyle,
      eventListeners,
    };
  }

  // 8. Network
  if (cmd === 'network_requests') {
    return {
      requests: listNetworkRequests({
        resourceTypes: data.resourceTypes,
        filter: data.filter,
        limit: data.limit,
      }),
    };
  }

  if (cmd === 'network_request_detail') {
    if (!data.requestId) return { error: "Missing requestId", hint: "Call network_requests first and pass one of the returned request ids." };
    return await getNetworkRequestDetail(target, data.requestId);
  }

  if (cmd === 'network_clear') {
    clearNetworkRequests();
    return { success: true, message: "Network log cleared." };
  }

  // 9. Evaluate JS
  if (cmd === 'evaluate') {
    const res = await sendCommand<Protocol.Runtime.EvaluateResponse>(target, 'Runtime.evaluate', { expression: data.expression, returnByValue: true });
    if (res?.exceptionDetails) {
      return { error: res.exceptionDetails.text, hint: "The expression threw. Check for syntax errors or references to elements that don't exist yet." };
    }
    return { success: true, result: res?.result?.value };
  }

  return {
    error: `Unknown command: ${cmd}`,
    hint: `This loaded extension is v${EXTENSION_VERSION}. If "${cmd}" is a real browsercontrol command, the extension in chrome://extensions is running an older build than the daemon — reload it there (MV3 extensions never pick up source changes automatically). Do not work around this by installing other automation libraries; it's a stale-extension issue, not a missing capability.`,
  };
}

async function handleNavigate(url: string): Promise<Record<string, unknown>> {
  clearNetworkRequests();
  const groups = await chrome.tabGroups.query({ title: GROUP_NAME });
  let groupId: number | null = null;

  let windowId: number | undefined;
  // activeTabId is in-memory extension state; it goes stale the moment the
  // tab it points at is closed (by the user, or previous testing), and the
  // service worker has no way to notice that on its own — it just keeps the
  // old id until something tries to use it. Fall back to creating a fresh
  // tab instead of hard-failing the whole navigate.
  let existingTabIsValid = false;
  if (activeTabId) {
    try {
      await chrome.tabs.get(activeTabId);
      existingTabIsValid = true;
    } catch {
      console.log(`Stale activeTabId ${activeTabId} (tab no longer exists) — creating a new tab.`);
      activeTabId = null;
      isDebuggerAttached = false;
    }
  }

  if (!existingTabIsValid) {
    const newTab = await chrome.tabs.create({ url: url, active: true });
    activeTabId = newTab.id!;
    windowId = newTab.windowId;
  } else {
    const updatedTab = await chrome.tabs.update(activeTabId!, { url: url, active: true });
    windowId = updatedTab?.windowId;
  }
  // Capture as a definite non-null local — activeTabId is module state that
  // TS can't narrow through the async control flow above, but by this point
  // it's always set (either just-created or confirmed-valid).
  const tabId: number = activeTabId!;

  // Making the tab "active" only matters within Chrome — if the Chrome
  // window itself isn't focused at the OS level (e.g. a terminal is in
  // front), the click/type cursor and highlight animations run but nobody
  // is looking at them. Bring the window forward too.
  if (windowId !== undefined) {
    chrome.windows.update(windowId, { focused: true }, () => {
      if (chrome.runtime.lastError) console.log('Could not focus window:', chrome.runtime.lastError.message);
    });
  }

  if (groups.length > 0) {
    groupId = groups[0].id;
    await chrome.tabs.group({ tabIds: tabId, groupId: groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, { title: GROUP_NAME, color: 'red' });
  }

  // Wait for the browser-level load event, then let the page's own JS settle
  // (SPA hydration, redirects) instead of guessing with a fixed sleep.
  await new Promise<void>((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  await attachDebuggerIfNeeded(tabId);
  await waitForStableDom({ tabId }, { timeoutMs: 3000 });

  return { success: true, message: `Navigated to ${url}` };
}

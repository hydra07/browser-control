import type { Protocol } from 'devtools-protocol';
import type { BrowserCommand } from '../shared/protocol.js';
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
// so it must not reference anything from the extension's closure.
function drawAnnotationOverlay(boxes: Array<{ id: number; x: number; y: number; w: number; h: number }>) {
  const old = document.getElementById('__bc_annotate_overlay__');
  if (old) old.remove();
  const container = document.createElement('div');
  container.id = '__bc_annotate_overlay__';
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.body.appendChild(container);
  for (const b of boxes) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:2px solid #ff3366;box-sizing:border-box;background:rgba(255,51,102,0.08);`;
    const label = document.createElement('div');
    label.textContent = String(b.id);
    label.style.cssText = 'position:absolute;top:-16px;left:-2px;background:#ff3366;color:#fff;font:11px monospace;padding:1px 4px;line-height:1.2;white-space:nowrap;';
    box.appendChild(label);
    container.appendChild(box);
  }
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
function moveCursorTo(x: number, y: number): Promise<void> {
  return new Promise((resolve) => {
    // Diagnostic: open DevTools (F12) on the page itself and watch for this
    // — if it never appears, the injected code isn't running at all (page
    // JS error, CSP, or a debugger command failure upstream). If it DOES
    // appear but nothing is visible, the element is rendering but hidden —
    // most likely a page-level CSS ancestor with transform/filter/perspective,
    // which makes position:fixed descendants position relative to THAT
    // ancestor's box instead of the real viewport, not this code.
    console.log('[browsercontrol] moveCursorTo', x, y);
    // documentElement (<html>) instead of body: fewer real-world apps put a
    // transform/filter on <html> than on <body> or a layout wrapper div, so
    // appending here is less likely to get silently clipped/repositioned by
    // an ancestor's CSS.
    let cursor = document.getElementById('__bc_cursor__') as HTMLDivElement | null;
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__bc_cursor__';
      // Slight overshoot easing (back-out) reads as a more natural glide
      // than linear/ease — same idea as native OS pointer/spring animations.
      cursor.style.cssText = 'all:initial;position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(255,255,255,0.95);border:2px solid #111;box-shadow:0 0 0 2px rgba(0,0,0,0.2),0 2px 6px rgba(0,0,0,0.35);z-index:2147483647;pointer-events:none;transition:left 0.35s cubic-bezier(0.34,1.56,0.64,1),top 0.35s cubic-bezier(0.34,1.56,0.64,1);left:-100px;top:-100px;';
      document.documentElement.appendChild(cursor);
    }
    // Force a layout flush so the transition animates from the cursor's
    // current position instead of jumping straight to the new one.
    void cursor.offsetWidth;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    setTimeout(resolve, 380);
  });
}

// Self-contained: injected via .toString(). A brief ripple at the exact
// point a click was dispatched — separate from the corner-bracket highlight
// (which marks the element), this marks the precise pixel the mouse event
// fired at, the same "tap feedback" pattern as native touch/click UIs.
function showClickRipple(x: number, y: number, color: string) {
  console.log('[browsercontrol] showClickRipple', x, y);
  const ripple = document.createElement('div');
  ripple.style.cssText = `all:initial;position:fixed;left:${x}px;top:${y}px;width:0;height:0;margin:0;border-radius:50%;background:${color};opacity:0.55;transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;transition:width 0.4s ease-out,height 0.4s ease-out,opacity 0.4s ease-out;`;
  document.documentElement.appendChild(ripple);
  requestAnimationFrame(() => {
    ripple.style.width = '36px';
    ripple.style.height = '36px';
    ripple.style.opacity = '0';
  });
  setTimeout(() => ripple.remove(), 450);
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

async function dispatchCommand(data: BrowserCommand & { id?: string }): Promise<Record<string, unknown>> {
  const cmd = data.cmd;

  // 1. Session Initialization (navigate)
  if (cmd === 'navigate') {
    return await handleNavigate(data.url);
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

    // getBoxModel returns coordinates relative to the CURRENT viewport. If
    // the element is scrolled out of view, those coordinates land outside
    // the visible area — the click misses (or hits whatever else is there)
    // and the cursor/highlight animate somewhere invisible.
    await sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: data.nodeId });

    // Get Box Model to find coordinates
    const boxModel = await sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId: data.nodeId });

    if (boxModel && boxModel.model) {
      const box = quadToBox(boxModel.model.content);
      const x = box.x + box.w / 2;
      const y = box.y + box.h / 2;

      // Glide the cursor there first, then highlight — visible movement
      // instead of a highlight teleporting straight to the target. Fetch
      // role/name concurrently — independent of the animation, needed for
      // replay to re-resolve this element by identity instead of stale id.
      const [, axInfo] = await Promise.all([
        evalOnPage(target, `(${moveCursorTo.toString()})(${x}, ${y})`, true),
        getAxInfoForNode(target, data.nodeId),
      ]);
      await showNativeHighlight(target, box, { r: 34, g: 197, b: 94 });

      // Dispatch mousedown and mouseup
      await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      void evalOnPage(target, `(${showClickRipple.toString()})(${x}, ${y}, '#22c55e')`);
      await sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await waitForStableDom(target);
      setTimeout(() => hideNativeHighlight(target), 400);

      return { success: true, message: `Clicked at (${x}, ${y})`, role: axInfo.role, name: axInfo.name };
    }
    return { error: "Failed to resolve node bounds", hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry." };
  }

  // 4. Type (focus + insertText)
  if (cmd === 'type') {
    if (!data.text) return { error: "Missing text" };
    let axInfo: { role?: string; name?: string } = {};
    if (data.nodeId) {
      await sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: data.nodeId });

      const focusResult = await sendCommand<CdpResult<{}>>(target, 'DOM.focus', { backendNodeId: data.nodeId });
      if (focusResult?.error) {
        return { error: `Failed to focus node: ${focusResult.error.message}`, hint: "The node id may be stale, or the element isn't focusable (e.g. a div, not an input). Take a fresh snapshot and confirm it's an input/textbox node." };
      }

      const [boxModel, resolvedAxInfo] = await Promise.all([
        sendCommand<Protocol.DOM.GetBoxModelResponse>(target, 'DOM.getBoxModel', { backendNodeId: data.nodeId }),
        getAxInfoForNode(target, data.nodeId),
      ]);
      axInfo = resolvedAxInfo;
      if (boxModel?.model?.content) {
        const box = quadToBox(boxModel.model.content);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        await evalOnPage(target, `(${moveCursorTo.toString()})(${cx}, ${cy})`, true);
        await showNativeHighlight(target, box, { r: 59, g: 130, b: 246 });
        setTimeout(() => hideNativeHighlight(target), 600);
      }
    }
    // Input.insertText types into whichever element currently has focus, so
    // focusing first (above) is required — without a nodeId this relies on
    // something already being focused (e.g. right after a click).
    await sendCommand(target, 'Input.insertText', { text: data.text });
    await waitForStableDom(target);
    return { success: true, message: `Typed "${data.text}"`, role: axInfo.role, name: axInfo.name };
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

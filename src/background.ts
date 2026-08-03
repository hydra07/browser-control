import { waitForStableDom } from './lib/wait.js';
import { installDialogAutoHandler } from './lib/dialog.js';
import { installNetworkCollector, listNetworkRequests, getNetworkRequestDetail, clearNetworkRequests } from './lib/network.js';

const WS_URL = 'ws://127.0.0.1:8765';
const GROUP_NAME = '🤖 AI Workspace';
// Single source of truth is manifest.json — bump its "version" whenever
// background.ts changes, so a stale loaded extension is easy to spot instead
// of failing mysteriously with "Unknown command" on tools that exist in the
// source but were never reloaded into Chrome.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let ws: WebSocket | null = null;
let activeTabId: number | null = null;
let isDebuggerAttached = false;

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'treeitem', 'tab', 'slider']);

function buildSnapshotNodes(nodes: any[]) {
  return nodes.filter((node: any) => {
    const role = node.role?.value;
    if (!role) return false;

    // Keep interactive elements, but only if they resolve to a real DOM
    // node — otherwise click/type would receive an id they can never use.
    if (INTERACTIVE_ROLES.has(role)) return !!node.backendDOMNodeId;

    // Keep text nodes if they have content
    if (role === 'StaticText' || role === 'heading' || role === 'paragraph') {
      const text = node.name?.value?.trim();
      return text && text.length > 0;
    }

    return false;
  }).map((node: any) => ({
    // backendDOMNodeId (DOM domain), NOT nodeId (Accessibility-tree-only id).
    // click/type resolve elements via DOM.getBoxModel, which only accepts
    // the former; passing the latter silently targets the wrong element.
    id: node.backendDOMNodeId,
    role: node.role?.value,
    name: node.name?.value,
    value: node.value?.value,
  }));
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

function quadToBox(quad: number[]): { x: number; y: number; w: number; h: number } {
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
    let cursor = document.getElementById('__bc_cursor__') as HTMLDivElement | null;
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__bc_cursor__';
      cursor.style.cssText = 'position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(255,255,255,0.9);border:2px solid #111;box-shadow:0 0 0 2px rgba(0,0,0,0.25),0 1px 4px rgba(0,0,0,0.35);z-index:2147483647;pointer-events:none;transition:left 0.35s ease,top 0.35s ease;left:-100px;top:-100px;';
      document.body.appendChild(cursor);
    }
    // Force a layout flush so the transition animates from the cursor's
    // current position instead of jumping straight to the new one.
    void cursor.offsetWidth;
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    setTimeout(resolve, 380);
  });
}

// Self-contained: injected via .toString(). Draws a brief highlight around
// the exact element an action just touched, so anyone watching the tab (or a
// screen recording) can see what browser_click/browser_type acted on, in
// real time — distinct from browser_visual_snapshot's static "here are all
// the candidates" overlay.
function flashElementHighlight(box: { x: number; y: number; w: number; h: number }, color: string) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;border:3px solid ${color};border-radius:3px;box-sizing:border-box;background:${color}22;z-index:2147483647;pointer-events:none;opacity:1;transition:opacity 0.6s ease-out;`;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 600);
  }, 400);
}

function removeAnnotationOverlay() {
  document.getElementById('__bc_annotate_overlay__')?.remove();
}

function ensureConnected(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connect();
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log(`🟢 Connected to BrowserControl Daemon (extension v${EXTENSION_VERSION})`);
  };

  ws.onmessage = async (event: MessageEvent) => {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch (e: any) {
      console.error('Received malformed message:', e);
      return;
    }
    try {
      const result = await dispatchCommand(data);
      ws?.send(JSON.stringify({ id: data.id, type: 'result', data: result }));
    } catch (e: any) {
      console.error('Error handling message:', e);
      ws?.send(JSON.stringify({ id: data.id, type: 'error', error: e.toString() }));
    }
  };

  ws.onclose = () => {
    console.log('🔴 Disconnected from Daemon. Will retry on next keepalive tick.');
    // Best-effort immediate retry (works if the service worker is still alive
    // right now). The alarm below is the real safety net if it isn't.
    ensureConnected();
  };

  ws.onerror = () => ws?.close();
}

// MV3 service workers are killed by Chrome after ~30s idle, which silently
// drops the WebSocket with no event the extension can react to later (the
// timer just never fires again). A periodic alarm wakes the worker back up so
// it can notice the dead connection and reconnect. 1 minute is the practical
// floor for periodic alarms in a packed/production extension.
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') ensureConnected();
});
chrome.runtime.onStartup.addListener(ensureConnected);

installDialogAutoHandler();
installNetworkCollector(() => activeTabId);
ensureConnected();

async function attachDebuggerIfNeeded(tabId: number) {
  if (!isDebuggerAttached) {
    await new Promise<void>((resolve) => {
      chrome.debugger.attach({ tabId }, '1.3', () => resolve());
    });
    isDebuggerAttached = true;
    // Page: lets us auto-handle dialogs. DOM: required by getBoxModel.
    await new Promise<void>((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => resolve());
    });
    await new Promise<void>((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {}, () => resolve());
    });
    await new Promise<void>((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => resolve());
    });
    // CSS: required by getMatchedStylesForNode / getComputedStyleForNode.
    await new Promise<void>((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'CSS.enable', {}, () => resolve());
    });
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

async function dispatchCommand(data: any): Promise<any> {
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
    const axTreeResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {}, resolve);
    });

    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);

    return {
      message: "Extracted and Filtered Accessibility Tree",
      totalRawNodes: nodes.length,
      filteredNodesCount: filteredNodes.length,
      nodes: filteredNodes
    };
  }

  // 2b. Visual snapshot: same as snapshot, plus a screenshot with numbered
  // boxes drawn over every interactive element so an id can be grounded to a
  // position on screen before clicking, instead of guessing from text alone.
  if (cmd === 'visual_snapshot') {
    const axTreeResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {}, resolve);
    });
    const nodes = axTreeResult?.nodes || [];
    const filteredNodes = buildSnapshotNodes(nodes);

    const MAX_ANNOTATED = 40;
    const toAnnotate = filteredNodes.filter((n: any) => n.id != null).slice(0, MAX_ANNOTATED);

    const boxes: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
    await Promise.all(toAnnotate.map((node: any) => new Promise<void>((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { backendNodeId: node.id }, (boxModel: any) => {
        const quad = boxModel?.model?.content;
        if (quad) {
          const box = quadToBox(quad);
          if (box.w > 0 && box.h > 0) boxes.push({ id: node.id, ...box });
        }
        resolve();
      });
    })));

    await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(${drawAnnotationOverlay.toString()})(${JSON.stringify(boxes)})`,
      }, resolve);
    });

    const shot: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 }, resolve);
    });

    await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(${removeAnnotationOverlay.toString()})()`,
      }, resolve);
    });

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
    await new Promise((r) => chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: data.nodeId }, r));

    // Get Box Model to find coordinates
    const boxModel: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { backendNodeId: data.nodeId }, resolve);
    });

    if (boxModel && boxModel.model) {
      const box = quadToBox(boxModel.model.content);
      const x = box.x + box.w / 2;
      const y = box.y + box.h / 2;

      // Glide the cursor there first, then highlight — visible movement
      // instead of a highlight teleporting straight to the target.
      await new Promise((r) => chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(${moveCursorTo.toString()})(${x}, ${y})`,
        awaitPromise: true,
      }, r));
      await new Promise((r) => chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `(${flashElementHighlight.toString()})(${JSON.stringify(box)}, '#22c55e')`,
      }, r));

      // Dispatch mousedown and mouseup
      await new Promise(r => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, r));
      await new Promise(r => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, r));
      await waitForStableDom(target);

      return { success: true, message: `Clicked at (${x}, ${y})` };
    }
    return { error: "Failed to resolve node bounds", hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry." };
  }

  // 4. Type (focus + insertText)
  if (cmd === 'type') {
    if (!data.text) return { error: "Missing text" };
    if (data.nodeId) {
      await new Promise((r) => chrome.debugger.sendCommand(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: data.nodeId }, r));

      const focusResult: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'DOM.focus', { backendNodeId: data.nodeId }, resolve);
      });
      if (focusResult?.error) {
        return { error: `Failed to focus node: ${focusResult.error.message}`, hint: "The node id may be stale, or the element isn't focusable (e.g. a div, not an input). Take a fresh snapshot and confirm it's an input/textbox node." };
      }

      const boxModel: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { backendNodeId: data.nodeId }, resolve);
      });
      if (boxModel?.model?.content) {
        const box = quadToBox(boxModel.model.content);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        await new Promise((r) => chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(${moveCursorTo.toString()})(${cx}, ${cy})`,
          awaitPromise: true,
        }, r));
        await new Promise((r) => chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `(${flashElementHighlight.toString()})(${JSON.stringify(box)}, '#3b82f6')`,
        }, r));
      }
    }
    // Input.insertText types into whichever element currently has focus, so
    // focusing first (above) is required — without a nodeId this relies on
    // something already being focused (e.g. right after a click).
    await new Promise(r => chrome.debugger.sendCommand(target, 'Input.insertText', { text: data.text }, r));
    await waitForStableDom(target);
    return { success: true, message: `Typed "${data.text}"` };
  }

  // 5. Scroll
  if (cmd === 'scroll') {
    const deltaX = data.deltaX || 0;
    const deltaY = data.deltaY || 0;
    // Note: scroll needs x,y coordinates to apply the wheel event. We just use center screen.
    await new Promise(r => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 500, deltaX, deltaY }, r));
    await waitForStableDom(target);
    return { success: true, message: `Scrolled by (${deltaX}, ${deltaY})` };
  }

  // 6. Screenshot
  if (cmd === 'screenshot') {
    const format = data.format === 'png' ? 'png' : 'jpeg';
    const params: any = { format };
    if (format === 'jpeg') params.quality = data.quality ?? 80;

    if (data.fullPage) {
      const metrics: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics', {}, resolve);
      });
      const contentSize = metrics?.cssContentSize ?? metrics?.contentSize;
      if (contentSize) {
        params.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }

    const res: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params, resolve);
    });
    if (!res?.data) {
      return { error: 'Failed to capture screenshot', hint: 'The page or debugger session may be in a bad state; try navigating again.' };
    }
    return { success: true, format, dataBase64: res.data };
  }

  // 7. Inspect element (style + logic detail for ONE node, on demand)
  if (cmd === 'inspect_element') {
    if (!data.nodeId) return { error: "Missing nodeId", hint: "Call snapshot or visual_snapshot first and pass one of the returned node ids." };
    const backendNodeId = data.nodeId;

    const describeResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.describeNode', { backendNodeId }, resolve);
    });
    if (describeResult?.error || !describeResult?.node) {
      return { error: 'Failed to resolve node', hint: 'The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry.' };
    }

    const outerHTMLResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.getOuterHTML', { backendNodeId }, resolve);
    });
    let outerHTML: string | undefined = outerHTMLResult?.outerHTML;
    let outerHTMLTruncated = false;
    const MAX_HTML_CHARS = 5000;
    if (typeof outerHTML === 'string' && outerHTML.length > MAX_HTML_CHARS) {
      outerHTML = outerHTML.slice(0, MAX_HTML_CHARS);
      outerHTMLTruncated = true;
    }

    // CSS domain methods need a session-scoped nodeId, not backendNodeId.
    const pushResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] }, resolve);
    });
    const nodeId = pushResult?.nodeIds?.[0];

    let matchedRules: any[] = [];
    let computedStyle: Record<string, string> = {};
    if (nodeId) {
      const matchedResult: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'CSS.getMatchedStylesForNode', { nodeId }, resolve);
      });
      matchedRules = (matchedResult?.matchedCSSRules || []).slice(0, 15).map((m: any) => ({
        selector: m.rule?.selectorList?.text,
        origin: m.rule?.origin,
        properties: Object.fromEntries(
          (m.rule?.style?.cssProperties || [])
            .filter((p: any) => !p.disabled)
            .map((p: any) => [p.name, p.value]),
        ),
      }));

      const computedResult: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'CSS.getComputedStyleForNode', { nodeId }, resolve);
      });
      for (const prop of computedResult?.computedStyle || []) {
        if (RELEVANT_STYLE_PROPS.has(prop.name)) computedStyle[prop.name] = prop.value;
      }
    }

    // Event listeners: DOMDebugger works on a Runtime remote object, not a
    // DOM node id, so resolve one and release it when done.
    let eventListeners: any[] = [];
    const resolveResult: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId }, resolve);
    });
    const objectId = resolveResult?.object?.objectId;
    if (objectId) {
      const listenersResult: any = await new Promise((resolve) => {
        chrome.debugger.sendCommand(target, 'DOMDebugger.getEventListeners', { objectId }, resolve);
      });
      eventListeners = (listenersResult?.listeners || []).map((l: any) => ({
        type: l.type,
        useCapture: l.useCapture,
        passive: l.passive,
        once: l.once,
      }));
      chrome.debugger.sendCommand(target, 'Runtime.releaseObject', { objectId }, () => {});
    }

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
    const res: any = await new Promise((resolve) => {
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: data.expression, returnByValue: true }, resolve);
    });
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

async function handleNavigate(url: string): Promise<any> {
  clearNetworkRequests();
  const groups = await chrome.tabGroups.query({ title: GROUP_NAME });
  let groupId: number | null = null;

  if (!activeTabId) {
    const newTab = await chrome.tabs.create({ url: url, active: true });
    activeTabId = newTab.id!;
  } else {
    await chrome.tabs.update(activeTabId, { url: url, active: true });
  }

  if (groups.length > 0) {
    groupId = groups[0].id;
    await chrome.tabs.group({ tabIds: activeTabId, groupId: groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: activeTabId });
    await chrome.tabGroups.update(groupId, { title: GROUP_NAME, color: 'red' });
  }

  // Wait for the browser-level load event, then let the page's own JS settle
  // (SPA hydration, redirects) instead of guessing with a fixed sleep.
  await new Promise<void>((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === activeTabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  await attachDebuggerIfNeeded(activeTabId);
  await waitForStableDom({ tabId: activeTabId }, { timeoutMs: 3000 });

  return { success: true, message: `Navigated to ${url}` };
}

// Runs inside the offscreen document. chrome.debugger is NOT available here
// (offscreen documents only get chrome.runtime), so this file's only job is
// holding the WebSocket to the daemon and relaying each message to the
// service worker (which does all the actual CDP work) via
// chrome.runtime.sendMessage. Unlike the service worker, an offscreen
// document isn't killed after ~30s idle, so the WS connection itself never
// drops due to extension lifecycle — only real network events (daemon
// restart, etc.) close it, and those get a real reconnect-with-backoff
// instead of waiting for a periodic alarm to notice.

import type { BrowserCommand } from '@browsercontrol/shared';
import { startCapture, stopCapture } from '../../lib/capture.js';
import { handleBatchCrawlCommand } from '../../lib/batch.js';
import { handleWebSearchCommand } from '../../lib/search.js';

type IncomingMessage = BrowserCommand & { id: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const WS_URL = 'ws://127.0.0.1:8765';
const MAX_RECONNECT_DELAY_MS = 15000;

let ws: WebSocket | null = null;
let reconnectDelayMs = 1000;

function ensureConnected(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connect();
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[offscreen] Connected to daemon');
    reconnectDelayMs = 1000;
  };

  ws.onmessage = async (event: MessageEvent) => {
    let data: IncomingMessage;
    try {
      data = JSON.parse(event.data) as IncomingMessage;
    } catch (e: unknown) {
      console.error('[offscreen] Received malformed message:', errorMessage(e));
      return;
    }

    // start_capture/stop_capture and batch_crawl/web_search need a real DOM
    // context (MediaRecorder/DOMParser), which only exists here in offscreen,
    // not in the service worker. Handle them right here.
    if (data.cmd === 'start_capture' || data.cmd === 'stop_capture') {
      try {
        const result = data.cmd === 'start_capture' ? await startCapture() : await stopCapture();
        ws?.send(JSON.stringify({ id: data.id, type: 'result', data: result }));
      } catch (e: unknown) {
        console.error('[offscreen] Capture command failed:', errorMessage(e));
        ws?.send(JSON.stringify({ id: data.id, type: 'error', error: errorMessage(e) }));
      }
      return;
    }

    // Same reason as above: both need fetch()+DOMParser, which this
    // document has and the service worker doesn't.
    if (data.cmd === 'batch_crawl' || data.cmd === 'web_search') {
      try {
        const result =
          data.cmd === 'batch_crawl'
            ? await handleBatchCrawlCommand(data)
            : await handleWebSearchCommand(data);
        ws?.send(JSON.stringify({ id: data.id, type: 'result', data: result }));
      } catch (e: unknown) {
        console.error(`[offscreen] ${data.cmd} failed:`, errorMessage(e));
        ws?.send(JSON.stringify({ id: data.id, type: 'error', error: errorMessage(e) }));
      }
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({ target: 'background', payload: data });
      ws?.send(JSON.stringify({ id: data.id, type: 'result', data: result }));
    } catch (e: unknown) {
      console.error('[offscreen] Error relaying to background:', errorMessage(e));
      ws?.send(JSON.stringify({ id: data.id, type: 'error', error: errorMessage(e) }));
    }
  };

  ws.onclose = () => {
    console.log(`[offscreen] Disconnected from daemon, retrying in ${reconnectDelayMs}ms`);
    setTimeout(ensureConnected, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  };

  ws.onerror = () => ws?.close();
}

ensureConnected();

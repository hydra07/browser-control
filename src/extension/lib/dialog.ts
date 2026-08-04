import type { Protocol } from 'devtools-protocol';

// A blocking dialog (alert/confirm/prompt) freezes the renderer, so any
// automation waiting on that tab hangs with no timeout to save it. Auto-dismiss
// them and let the agent see the outcome via the command's return value instead.
export function installDialogAutoHandler(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.javascriptDialogOpening' || !source.tabId) return;
    const p = params as Protocol.Page.JavascriptDialogOpeningEvent;
    chrome.debugger.sendCommand(
      { tabId: source.tabId },
      'Page.handleJavaScriptDialog',
      { accept: false },
    );
    console.log(`Auto-dismissed a blocking "${p.type}" dialog: "${p.message}"`);
  });
}

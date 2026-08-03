// A blocking dialog (alert/confirm/prompt) freezes the renderer, so any
// automation waiting on that tab hangs with no timeout to save it. Auto-dismiss
// them and let the agent see the outcome via the command's return value instead.
export function installDialogAutoHandler(): void {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (method !== 'Page.javascriptDialogOpening' || !source.tabId) return;
    chrome.debugger.sendCommand(
      { tabId: source.tabId },
      'Page.handleJavaScriptDialog',
      { accept: false },
    );
    console.log(`Auto-dismissed a blocking "${params.type}" dialog: "${params.message}"`);
  });
}

// Every chrome.debugger.sendCommand call used to be hand-wrapped in
// `new Promise((resolve) => chrome.debugger.sendCommand(...))` with the
// result typed `any` — @types/chrome has no way to link a CDP method string
// to its actual response shape. This wrapper does that linkage manually via
// an explicit type parameter backed by devtools-protocol's Protocol
// namespace (the same source of truth Chrome's own DevTools frontend is
// generated from), and folds the repeated Promise-wrapping into one place.
export function sendCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params: object = {},
): Promise<T> {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand(target, method, params, (result) => resolve(result as T));
  });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

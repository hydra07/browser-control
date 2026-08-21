/** What dispatchCommand/handleNavigate need from background.ts's session-state closures, passed in rather than imported — same reasoning as the server's ToolHandlerCtx: this module shouldn't own chrome.debugger attach-state bookkeeping (the idle-detach alarm in background.ts already does). */
export interface DispatchCtx {
    getLastActiveTabId: () => number | null;
    setLastActiveTabId: (id: number | null) => void;
    /** Attaches the CDP debugger to a tab if not already attached, and enables the CDP domains every command needs. */
    attachDebuggerIfNeeded: (tabId: number) => Promise<void>;
    /** This build's manifest version — surfaced in the "Unknown command" hint so a stale-extension mismatch is easy to spot. */
    extensionVersion: string;
}

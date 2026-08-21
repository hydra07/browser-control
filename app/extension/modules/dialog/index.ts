import type { Protocol } from "devtools-protocol";
import { sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";

/** Auto-dismiss blocking JavaScript dialogs (alert/confirm/prompt) to prevent automation deadlocks. */
export function installDialogAutoHandler(): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method !== "Page.javascriptDialogOpening" || !source.tabId) return;
        const p = params as Protocol.Page.JavascriptDialogOpeningEvent;
        sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", { accept: false }).catch((e) =>
            console.error("[browsercontrol] failed to auto-dismiss dialog:", errorMessage(e)),
        );
        console.log(`Auto-dismissed a blocking "${p.type}" dialog: "${p.message}"`);
    });
}

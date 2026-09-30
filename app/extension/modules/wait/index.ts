import type { SettleReason } from "@browsercontrol/shared";
import { sendCommand } from "../../libs/cdp.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { NAVIGATION_FALLBACK_TIMEOUT_MS } from "./constants.js";

/** True for the errors CDP raises when a real navigation tears down the frame mid-evaluate (e.g. clicking a real `<a href>`), as opposed to an ordinary evaluate failure. */
function isNavigationTeardownError(e: unknown): boolean {
    const msg = errorMessage(e).toLowerCase();
    return (
        msg.includes("context was destroyed") ||
        msg.includes("cannot find context") ||
        msg.includes("target navigated") ||
        msg.includes("execution context")
    );
}

/** Resolves once the given tab reaches status "complete", bounded by timeoutMs. Mirrors handleNavigate's own load wait in dispatch/index.ts. */
function waitForTabLoadComplete(tabId: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, timeoutMs);
        function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo) {
            if (updatedTabId === tabId && info.status === "complete") {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

export type { SettleReason } from "@browsercontrol/shared";

export interface SettleResult {
    reason: SettleReason;
}

/** Waits for bounded DOM quiet and reports why the settle window ended. */
export async function waitForStableDom(
    target: chrome.debugger.Debuggee,
    opts: { quietMs?: number; timeoutMs?: number } = {},
): Promise<SettleResult> {
    const quietMs = opts.quietMs ?? 150;
    const timeoutMs = opts.timeoutMs ?? 2000;

    const expression = `
        new Promise((resolve) => {
            let settleTimer;
            let hardTimer;
            const finish = (reason) => {
                try { observer.disconnect(); } catch (e) {}
                clearTimeout(settleTimer);
                clearTimeout(hardTimer);
                resolve(reason);
            };
            // BrowserControl's own cursor/ripple/badge overlays animate right after every action;
            // counting those would keep the page "busy" until the hard timeout on every call.
            const ours = (node) => {
                const el = node && (node.nodeType === 1 ? node : node.parentElement);
                return !!el && !!el.closest && !!el.closest('[id^="__bc_"], [class^="__bc_"]');
            };
            const external = (record) => {
                if (record.type !== "childList") return !ours(record.target);
                const changed = [...record.addedNodes, ...record.removedNodes];
                return changed.length === 0 ? !ours(record.target) : changed.some((n) => !ours(n));
            };
            const observer = new MutationObserver((records) => {
                if (!records.some(external)) return;
                clearTimeout(settleTimer);
                settleTimer = setTimeout(() => finish("dom_quiet"), ${quietMs});
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            settleTimer = setTimeout(() => finish("dom_quiet"), ${quietMs});
            hardTimer = setTimeout(() => finish("timeout"), ${timeoutMs});
        })
    `;

    return await new Promise<SettleResult>((resolve) => {
        let settled = false;
        const finish = (result: SettleResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            resolve(result);
        };
        // Guard against hung debugger evaluation. Wide enough to cover the
        // navigation-teardown fallback below, not just the plain DOM-quiet wait.
        const guard = setTimeout(() => finish({ reason: "timeout" }), timeoutMs + NAVIGATION_FALLBACK_TIMEOUT_MS + 500);
        void sendCommand(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
            .then((result) => {
                const reason = result?.result?.value;
                finish({ reason: reason === "timeout" ? "timeout" : "dom_quiet" });
            })
            .catch(async (e) => {
                // The evaluate call didn't fail because the page misbehaved —
                // the action itself (e.g. clicking a real <a href>) tore down
                // the frame it was running in. Treating that as "already
                // settled" used to hand the next flow step a half-loaded page;
                // wait for the browser-level load instead.
                if (target.tabId != null && isNavigationTeardownError(e)) {
                    await waitForTabLoadComplete(target.tabId, NAVIGATION_FALLBACK_TIMEOUT_MS);
                    finish({ reason: "load_complete" });
                    return;
                }
                finish({ reason: "timeout" });
            });
    });
}

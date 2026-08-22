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

/** Wait for DOM mutations to settle after an action (bounded by timeoutMs). */
export async function waitForStableDom(
    target: chrome.debugger.Debuggee,
    opts: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
    const quietMs = opts.quietMs ?? 150;
    const timeoutMs = opts.timeoutMs ?? 2000;

    const expression = `
        new Promise((resolve) => {
            let settleTimer;
            const finish = () => {
                try { observer.disconnect(); } catch (e) {}
                clearTimeout(settleTimer);
                clearTimeout(hardTimer);
                resolve(true);
            };
            const observer = new MutationObserver(() => {
                clearTimeout(settleTimer);
                settleTimer = setTimeout(finish, ${quietMs});
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            settleTimer = setTimeout(finish, ${quietMs});
            const hardTimer = setTimeout(finish, ${timeoutMs});
        })
    `;

    await new Promise<void>((resolve) => {
        // Guard against hung debugger evaluation. Wide enough to cover the
        // navigation-teardown fallback below, not just the plain DOM-quiet wait.
        const guard = setTimeout(resolve, timeoutMs + NAVIGATION_FALLBACK_TIMEOUT_MS + 500);
        void sendCommand(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
            .catch(async (e) => {
                // The evaluate call didn't fail because the page misbehaved —
                // the action itself (e.g. clicking a real <a href>) tore down
                // the frame it was running in. Treating that as "already
                // settled" used to hand the next flow step a half-loaded page;
                // wait for the browser-level load instead.
                if (target.tabId != null && isNavigationTeardownError(e)) {
                    await waitForTabLoadComplete(target.tabId, NAVIGATION_FALLBACK_TIMEOUT_MS);
                }
            })
            .finally(() => {
                clearTimeout(guard);
                resolve();
            });
    });
}

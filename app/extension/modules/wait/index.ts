import { sendCommand } from "../../libs/cdp.js";

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
        // Guard against hung debugger evaluation
        const guard = setTimeout(resolve, timeoutMs + 500);
        void sendCommand(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
            .catch(() => {})
            .finally(() => {
                clearTimeout(guard);
                resolve();
            });
    });
}

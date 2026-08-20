import { sendCommand } from './cdp.js';

// Waits for the page to settle (DOM stops mutating) after an action, instead
// of a fixed sleep. Bounded by timeoutMs so a page that never quiesces
// (animations, polling widgets) can't hang a command forever.
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
    // Extension-side guard in case the debugger command itself never calls back
    // (e.g. target navigated away mid-evaluation).
    const guard = setTimeout(resolve, timeoutMs + 500);
    void sendCommand(target, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      .catch(() => {})
      .finally(() => {
        clearTimeout(guard);
        resolve();
      });
  });
}

import { getSettings } from "../../configs/settings.js";
import { errorMessage } from "../../libs/errorMessage.js";
import { DEFAULT_MAX_CHARS } from "./constants.js";
import type { PeekScreenResult } from "./types.js";

export type { PeekScreenResult } from "./types.js";

/**
 * Safely peeks at the user's active screen or a specific tab in pure READ-ONLY mode.
 * Does not attach CDP debugger, mutate DOM, or click/type into the tab.
 */
export async function handlePeekScreenCommand(
    options: { tabId?: number; screenshot?: boolean; maxChars?: number; includeSelection?: boolean } = {},
): Promise<PeekScreenResult | { error: string; hint: string }> {
    try {
        let targetTab: chrome.tabs.Tab | undefined;
        if (options.tabId != null) {
            targetTab = await chrome.tabs.get(options.tabId).catch(() => undefined);
        } else {
            // Find active tab in current / last focused window
            const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            targetTab = tabs[0] || (await chrome.tabs.query({ active: true }))[0];
        }

        if (!targetTab?.id) {
            return {
                error: "No active browser tab found to peek.",
                hint: "Ensure at least one normal Chrome web tab is open.",
            };
        }

        const tabId = targetTab.id;
        const { tabGroupName } = await getSettings();
        let isWorkspaceTab = false;
        if (targetTab.groupId != null && targetTab.groupId > 0) {
            try {
                const group = await chrome.tabGroups.get(targetTab.groupId);
                isWorkspaceTab = group.title === tabGroupName;
            } catch {}
        }

        const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

        // Safely extract text & selection via chrome.scripting (purely read-only)
        let extracted: {
            selection: string;
            title: string;
            h1: string;
            bodyText: string;
            url: string;
        } | null = null;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: (limit: number) => {
                    const selection = window.getSelection()?.toString()?.trim() || "";
                    const title = document.title || "";
                    const h1 = document.querySelector("h1")?.textContent?.trim() || "";

                    const clone = document.body ? (document.body.cloneNode(true) as HTMLElement) : null;
                    if (clone) {
                        const noise = clone.querySelectorAll(
                            "script, style, noscript, svg, iframe, nav, footer, header",
                        );
                        noise.forEach((n) => n.remove());
                        const text = clone.innerText || clone.textContent || "";
                        return {
                            selection,
                            title,
                            h1,
                            bodyText: text.replace(/\s+/g, " ").trim().slice(0, limit),
                            url: window.location.href,
                        };
                    }
                    return {
                        selection,
                        title,
                        h1,
                        bodyText: "",
                        url: window.location.href,
                    };
                },
                args: [maxChars],
            });
            extracted = results?.[0]?.result || null;
        } catch {
            // chrome:// or restricted extension pages may reject executeScript
        }

        let screenshotBase64: string | undefined;
        if (options.screenshot && targetTab.windowId != null) {
            try {
                const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, {
                    format: "jpeg",
                    quality: 60,
                });
                if (dataUrl) {
                    screenshotBase64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
                }
            } catch {}
        }

        const rawText = extracted?.bodyText || "";
        const selectedText = extracted?.selection || undefined;

        return {
            tabId,
            url: extracted?.url || targetTab.url || "",
            title: extracted?.title || targetTab.title || "",
            isWorkspaceTab,
            permissions: isWorkspaceTab ? "control" : "read_only",
            selectedText: selectedText || undefined,
            h1: extracted?.h1 || undefined,
            text: rawText,
            textLength: rawText.length,
            screenshotBase64,
        };
    } catch (e) {
        return {
            error: `Failed to peek screen: ${errorMessage(e)}`,
            hint: "Make sure the target tab is not an internal chrome:// page.",
        };
    }
}

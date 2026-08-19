// list_tabs/switch_tab: the "🤖 AI Workspace" tab group as a shared handoff
// surface — the user drags tabs into it, the AI discovers them via
// list_tabs. Neither needs a CDP session, and both must work before any
// navigate has happened.
import { evalOnPage } from "./cdp.js";
import { showPillCaption } from "./overlay.js";

export const GROUP_NAME = "🤖 AI Workspace";

// Which tabs list_tabs has already reported, so a user-dropped-in tab shows
// isNew:true once. Reset (replaced, not merged) each call so a closed tab's
// id doesn't linger. unseenTabCount drives the toolbar badge — the only way
// to signal "a tab showed up" since MCP is pull-based.
let seenTabIds = new Set<number>();
let unseenTabCount = 0;

export function installTabGroupBadge(): void {
    chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
        if (changeInfo.groupId == null || changeInfo.groupId < 0) return;
        try {
            const group = await chrome.tabGroups.get(changeInfo.groupId);
            if (group.title !== GROUP_NAME) return;
        } catch {
            return;
        }
        unseenTabCount++;
        chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
        chrome.action.setBadgeText({ text: String(unseenTabCount) });
    });
}

export async function handleListTabsCommand(
    lastActiveTabId: number | null,
): Promise<Record<string, unknown>> {
    const groups = await chrome.tabGroups.query({ title: GROUP_NAME });
    if (groups.length === 0) return { tabs: [] };
    const tabs = await chrome.tabs.query({ groupId: groups[0].id });
    const result = tabs
        .filter((t) => t.id != null)
        .map((t) => ({
            tabId: t.id!,
            url: t.url,
            title: t.title,
            active: t.id === lastActiveTabId,
            isNew: !seenTabIds.has(t.id!),
        }));
    seenTabIds = new Set(result.map((t) => t.tabId));
    unseenTabCount = 0;
    chrome.action.setBadgeText({ text: "" });
    return { tabs: result };
}

export type SwitchTabResult =
    | { error: string; hint: string }
    | {
          success: true;
          message: string;
          url?: string;
          title?: string;
          newActiveTabId: number;
      };

// Does NOT touch the debugger session of whatever tab was active before —
// background.ts tracks attach state per tab now, so the previous tab stays
// attached and usable via an explicit tabId on later commands instead of
// being detached just because focus moved elsewhere.
export async function handleSwitchTabCommand(
    tabId: number,
): Promise<SwitchTabResult> {
    try {
        await chrome.tabs.get(tabId);
    } catch {
        return {
            error: `No tab with id ${tabId}`,
            hint: "Call browser_list_tabs again — it may have been closed.",
        };
    }
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
            if (chrome.runtime.lastError)
                console.log(
                    "Could not focus window:",
                    chrome.runtime.lastError.message,
                );
        });
    }
    void evalOnPage(
        { tabId },
        `(${showPillCaption.toString()})(${JSON.stringify("🔀")}, ${JSON.stringify(`Switched to tab: ${tab?.title ?? tabId}`)}, ${JSON.stringify("#c4b5fd")}, ${JSON.stringify("#8b5cf6")}, false)`,
    );
    return {
        success: true,
        message: `Switched to tab ${tabId}`,
        url: tab?.url,
        title: tab?.title,
        newActiveTabId: tabId,
    };
}

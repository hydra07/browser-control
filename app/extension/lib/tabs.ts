// list_tabs/switch_tab: the "🤖 AI Workspace" tab group (name/color
// user-configurable, see lib/settings.ts) as a shared handoff surface — the
// user drags tabs into it, the AI discovers them via list_tabs. Neither
// needs a CDP session, and both must work before any navigate has happened.
import { evalOnPage } from "./cdp.js";
import { showPillCaption, SWITCH_TAB_ICON_SVG } from "./overlay.js";
import { getSettings } from "./settings.js";

// handleNavigate used to look up/create this group inline with its own
// await chrome.tabGroups.query(...) / chrome.tabs.group(...) pair. That's
// safe for one navigate at a time, but browser_start_job fires several
// "navigate" commands concurrently (one per worker) — two calls landing
// between the query and the create both see "no group yet" and each create
// their own group, splitting tabs across duplicates. Serializing every
// add-to-group op through this single promise chain means only the first
// concurrent caller ever does the create; the rest just wait their turn and
// join the group it made.
let groupOpChain: Promise<unknown> = Promise.resolve();

export async function addTabToWorkspaceGroup(tabId: number): Promise<void> {
    const run = groupOpChain.then(async () => {
        const { tabGroupName, tabGroupColor } = await getSettings();
        const groups = await chrome.tabGroups.query({ title: tabGroupName });
        if (groups.length > 0) {
            await chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id });
        } else {
            const groupId = await chrome.tabs.group({ tabIds: tabId });
            await chrome.tabGroups.update(groupId, {
                title: tabGroupName,
                color: tabGroupColor,
            });
        }
    });
    // Keep the chain alive even if this op threw — one tab that failed to
    // group (e.g. its window closed mid-navigate) shouldn't wedge every
    // navigate after it.
    groupOpChain = run.catch(() => {});
    await run;
}

// Which tabs list_tabs has already reported, so a user-dropped-in tab shows
// isNew:true once. Reset (replaced, not merged) each call so a closed tab's
// id doesn't linger. unseenTabCount drives the toolbar badge — the only way
// to signal "a tab showed up" since MCP is pull-based.
let seenTabIds = new Set<number>();
let unseenTabCount = 0;

// chrome.action requires an "action" key in the manifest to exist at all
// (see wxt.config.ts's manifest.action:{}) — that alone should guarantee
// it, but a freshly-reloaded/cold-started service worker has been observed
// to hit this before the namespace is fully wired up, and a stale
// unrebuilt .output/ (missing the action key) would hit it every time. The
// badge is a nice-to-have notification, not load-bearing for any tool
// actually working — degrade to "no badge shown" instead of an uncaught
// rejection breaking whatever call triggered it.
function setBadge(text: string, color?: string): void {
    if (!chrome.action) {
        console.error(
            "[browsercontrol] chrome.action is unavailable — rebuild (bun run build) and fully reload the extension in chrome://extensions if this persists.",
        );
        return;
    }
    if (color) chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
}

export function installTabGroupBadge(): void {
    chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
        if (changeInfo.groupId == null || changeInfo.groupId < 0) return;
        try {
            const group = await chrome.tabGroups.get(changeInfo.groupId);
            if (group.title !== (await getSettings()).tabGroupName) return;
        } catch {
            return;
        }
        unseenTabCount++;
        setBadge(String(unseenTabCount), "#6366f1");
    });
}

export async function handleListTabsCommand(
    lastActiveTabId: number | null,
    options: { scope?: "workspace" | "all" } = {},
): Promise<Record<string, unknown>> {
    const { tabGroupName } = await getSettings();
    const groups = await chrome.tabGroups.query({ title: tabGroupName });
    const workspaceGroupId = groups.length > 0 ? groups[0].id : null;

    if (options.scope === "all") {
        const allTabs = await chrome.tabs.query({});
        const result = allTabs
            .filter((t) => t.id != null)
            .map((t) => {
                const inWorkspace = workspaceGroupId != null && t.groupId === workspaceGroupId;
                return {
                    tabId: t.id!,
                    url: t.url,
                    title: t.title,
                    inWorkspace,
                    permissions: inWorkspace ? "control" : "read_only",
                    active: t.id === lastActiveTabId,
                    userFocused: t.active,
                    isNew: !seenTabIds.has(t.id!),
                };
            });
        seenTabIds = new Set(result.map((t) => t.tabId));
        unseenTabCount = 0;
        setBadge("");
        return { tabs: result, scope: "all", workspaceGroupName: tabGroupName };
    }

    if (!workspaceGroupId) return { tabs: [] };
    const tabs = await chrome.tabs.query({ groupId: workspaceGroupId });
    const result = tabs
        .filter((t) => t.id != null)
        .map((t) => ({
            tabId: t.id!,
            url: t.url,
            title: t.title,
            inWorkspace: true,
            permissions: "control",
            active: t.id === lastActiveTabId,
            isNew: !seenTabIds.has(t.id!),
        }));
    seenTabIds = new Set(result.map((t) => t.tabId));
    unseenTabCount = 0;
    setBadge("");
    return { tabs: result, scope: "workspace" };
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
            hint: "Call browser_session({action:\"list_tabs\"}) again — it may have been closed.",
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
        `(${showPillCaption.toString()})(${JSON.stringify(SWITCH_TAB_ICON_SVG)}, ${JSON.stringify(`Switched to tab: ${tab?.title ?? tabId}`)}, ${JSON.stringify("#c4b5fd")}, ${JSON.stringify("#8b5cf6")}, false)`,
    );
    return {
        success: true,
        message: `Switched to tab ${tabId}`,
        url: tab?.url,
        title: tab?.title,
        newActiveTabId: tabId,
    };
}

/**
 * Workspace tab grouping, tab listing, switching, and toolbar badge management.
 */

import { getSettings } from "../../configs/settings.js";
import { evalOnPage } from "../../libs/cdp.js";
import { SWITCH_TAB_ICON_SVG, showPillCaption } from "../overlay/index.js";
import type { SwitchTabResult } from "./types.js";

export type { SwitchTabResult } from "./types.js";

function setBadge(text: string, color?: string): void {
    if (!chrome.action) {
        console.error("[browsercontrol] chrome.action is unavailable — rebuild (bun run build) and reload extension.");
        return;
    }
    if (color) chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
}

export class TabManager {
    private groupOpChain: Promise<unknown>;
    private seenTabIds: Set<number>;
    private unseenTabCount: number;
    private updateListener: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) | null;

    constructor() {
        this.groupOpChain = Promise.resolve();
        this.seenTabIds = new Set();
        this.unseenTabCount = 0;
        this.updateListener = null;
    }

    public async addTabToWorkspaceGroup(tabId: number): Promise<void> {
        const run = this.groupOpChain.then(async () => {
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
        this.groupOpChain = run.catch(() => {});
        await run;
    }

    public installTabGroupBadge(): void {
        if (this.updateListener) {
            chrome.tabs.onUpdated.removeListener(this.updateListener);
        }
        this.updateListener = async (_tabId, changeInfo) => {
            if (changeInfo.groupId == null || changeInfo.groupId < 0) return;
            try {
                const group = await chrome.tabGroups.get(changeInfo.groupId);
                if (group.title !== (await getSettings()).tabGroupName) return;
            } catch {
                return;
            }
            this.unseenTabCount++;
            setBadge(String(this.unseenTabCount), "#6366f1");
        };
        chrome.tabs.onUpdated.addListener(this.updateListener);
    }

    public async listTabs(
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
                        isNew: !this.seenTabIds.has(t.id!),
                    };
                });
            this.seenTabIds = new Set(result.map((t) => t.tabId));
            this.unseenTabCount = 0;
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
                isNew: !this.seenTabIds.has(t.id!),
            }));
        this.seenTabIds = new Set(result.map((t) => t.tabId));
        this.unseenTabCount = 0;
        setBadge("");
        return { tabs: result, scope: "workspace" };
    }

    public async switchTab(tabId: number): Promise<SwitchTabResult> {
        try {
            await chrome.tabs.get(tabId);
        } catch {
            return {
                error: `No tab with id ${tabId}`,
                hint: 'Call browser_session({action:"list_tabs"}) again — it may have been closed.',
            };
        }
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (tab?.windowId != null) {
            chrome.windows.update(tab.windowId, { focused: true }, () => {
                if (chrome.runtime.lastError) console.log("Could not focus window:", chrome.runtime.lastError.message);
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

    public clear(): void {
        this.seenTabIds.clear();
        this.unseenTabCount = 0;
    }

    public dispose(): void {
        if (this.updateListener) {
            chrome.tabs.onUpdated.removeListener(this.updateListener);
            this.updateListener = null;
        }
        this.seenTabIds.clear();
        this.unseenTabCount = 0;
        setBadge("");
    }
}

export const tabManager = new TabManager();

export function addTabToWorkspaceGroup(tabId: number): Promise<void> {
    return tabManager.addTabToWorkspaceGroup(tabId);
}

export function installTabGroupBadge(): void {
    tabManager.installTabGroupBadge();
}

export function handleListTabsCommand(
    lastActiveTabId: number | null,
    options?: { scope?: "workspace" | "all" },
): Promise<Record<string, unknown>> {
    return tabManager.listTabs(lastActiveTabId, options);
}

export function handleSwitchTabCommand(tabId: number): Promise<SwitchTabResult> {
    return tabManager.switchTab(tabId);
}

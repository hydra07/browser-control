/** User-configurable extension settings persisted via chrome.storage.local. */
export type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export const TAB_GROUP_COLORS: TabGroupColor[] = [
    "grey",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
];

export interface Settings {
    tabGroupName: string;
    tabGroupColor: TabGroupColor;
    animationsEnabled: boolean;
    recordingQuality: number;
    recordingMaxWidth: number;
    recordingMaxHeight: number;
    chatEnabled: boolean;
    cliAgentCommand: string;
}

export const DEFAULT_SETTINGS: Settings = {
    tabGroupName: "🤖 AI Workspace",
    tabGroupColor: "red",
    animationsEnabled: true,
    recordingQuality: 50,
    recordingMaxWidth: 1280,
    recordingMaxHeight: 900,
    chatEnabled: false,
    cliAgentCommand: "claude --print",
};

const STORAGE_KEY = "browsercontrol_settings";

// In-memory cache for synchronous hot-path reads
let cached: Settings = { ...DEFAULT_SETTINGS };

async function load(): Promise<Settings> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    cached = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
    return cached;
}
void load();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && STORAGE_KEY in changes) {
        cached = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue as Partial<Settings> | undefined) };
    }
});

/** Synchronous, cached — for hot-path reads. May briefly lag a write from another context (settings form saves, another tab). */
export function getSettingsSync(): Settings {
    return cached;
}

/** Always up to date — for one-off reads (the settings form's initial load, a navigate/recording start). */
export async function getSettings(): Promise<Settings> {
    return load();
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    cached = next;
    return next;
}

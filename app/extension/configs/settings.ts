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
    /** Bearer token paired with the local daemon; never included in normal UI output. */
    daemonAuthToken: string;
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
    daemonAuthToken: "",
};

const STORAGE_KEY = "browsercontrol_settings";

type SettingsResponse = { settings?: Partial<Settings>; error?: string };

function getLocalStorage(): chrome.storage.StorageArea | undefined {
    if (typeof chrome === "undefined") return undefined;
    return chrome.storage?.local;
}

function mergeSettings(value: unknown): Settings | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return { ...DEFAULT_SETTINGS, ...(value as Partial<Settings>) };
}

async function loadFromBackground(): Promise<Settings | null> {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return null;
    try {
        const response = (await chrome.runtime.sendMessage({ target: "background", type: "get_settings" })) as
            | SettingsResponse
            | undefined;
        const settings = mergeSettings(response?.settings);
        if (settings) cached = settings;
        return settings;
    } catch {
        return null;
    }
}

// In-memory cache for synchronous hot-path reads
let cached: Settings = { ...DEFAULT_SETTINGS };

async function load(): Promise<Settings> {
    const storage = getLocalStorage();
    if (!storage) return (await loadFromBackground()) ?? cached;
    const stored = await storage.get(STORAGE_KEY);
    cached = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
    return cached;
}
void load().catch(() => {});

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && STORAGE_KEY in changes) {
            cached = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue as Partial<Settings> | undefined) };
        }
    });
}

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
    const storage = getLocalStorage();
    if (storage) {
        await storage.set({ [STORAGE_KEY]: next });
    } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        const response = (await chrome.runtime.sendMessage({
            target: "background",
            type: "save_settings",
            patch,
        })) as SettingsResponse | undefined;
        const saved = mergeSettings(response?.settings);
        if (saved) cached = saved;
    }
    cached = next;
    return cached;
}

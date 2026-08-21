// User-configurable behavior, persisted via chrome.storage.local so it
// survives a service-worker restart/browser relaunch. Read from every
// context that needs it (service worker, sidepanel) — chrome.storage works
// identically in both, unlike chrome.debugger/CDP which is service-worker
// only.

export type TabGroupColor =
    | "grey"
    | "blue"
    | "red"
    | "yellow"
    | "green"
    | "pink"
    | "purple"
    | "cyan"
    | "orange";

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
    // Standalone click/type/press_key/scroll/drag glide the cursor and
    // ripple/highlight the target so a human watching can follow along —
    // see actions.ts's `fast` param. Off routes standalone actions through
    // the same fast path browser_act's run_flow steps already use.
    animationsEnabled: boolean;
    // Page.startScreencast params (screencast.ts) — higher quality/resolution
    // costs more per-frame decode+encode time in the offscreen canvas
    // pipeline, which directly caps frame rate (frames are ack'd one at a
    // time), so this is a real quality-vs-smoothness trade, not free.
    recordingQuality: number;
    recordingMaxWidth: number;
    recordingMaxHeight: number;
    // Enable Chat tab in sidepanel (Default: false)
    chatEnabled: boolean;
    // User-configurable CLI Agent command template (e.g. `claude --print`, `agy -p`, or custom CLI command/model)
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
    // Base binary + user-facing flags only — cliAgent.ts appends its own
    // streaming/mcp-config/session-resume flags on top when this is `claude`.
    cliAgentCommand: "claude --print",
};

const STORAGE_KEY = "browsercontrol_settings";

// Hot-path reads (a setting checked on every click/type, not just once per
// navigate/recording) skip the async chrome.storage round trip entirely via
// this cache. Starts at defaults and updates as soon as the real value
// loads or changes elsewhere, so only the very first command or two in a
// freshly (re)started service worker could see a stale-but-harmless
// default before the initial load resolves.
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

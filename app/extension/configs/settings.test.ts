import { afterEach, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, getSettings, type Settings, saveSettings } from "./settings";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
    Object.defineProperty(globalThis, "chrome", originalChrome ?? { configurable: true, value: undefined });
});

test("overlapping settings writes preserve unrelated fields and the pairing token", async () => {
    let stored: Settings = { ...DEFAULT_SETTINGS, daemonAuthToken: "test-pairing-token" };
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            storage: {
                local: {
                    async get() {
                        return { browsercontrol_settings: { ...stored } };
                    },
                    async set(value: { browsercontrol_settings: Settings }) {
                        await Promise.resolve();
                        stored = value.browsercontrol_settings;
                    },
                },
            },
        },
    });
    await Promise.all([saveSettings({ tabGroupName: "Work" }), saveSettings({ tabGroupColor: "blue" })]);
    expect(stored.tabGroupName).toBe("Work");
    expect(stored.tabGroupColor).toBe("blue");
    expect(stored.daemonAuthToken).toBe("test-pairing-token");
});

test("a rejected write does not poison the write queue", async () => {
    let rejectWrite = true;
    let stored: Settings = { ...DEFAULT_SETTINGS };
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            storage: {
                local: {
                    async get() {
                        return { browsercontrol_settings: stored };
                    },
                    async set(value: { browsercontrol_settings: Settings }) {
                        if (rejectWrite) throw new Error("Storage unavailable");
                        stored = value.browsercontrol_settings;
                    },
                },
            },
        },
    });
    await expect(saveSettings({ tabGroupName: "Work" })).rejects.toThrow("Storage unavailable");
    rejectWrite = false;
    await saveSettings({ tabGroupColor: "cyan" });
    expect((await getSettings()).tabGroupColor).toBe("cyan");
});

test("background save errors are surfaced instead of updating the cache as if saved", async () => {
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            runtime: {
                async sendMessage(message: { type: string }) {
                    return message.type === "get_settings"
                        ? { settings: DEFAULT_SETTINGS }
                        : { error: "Storage unavailable" };
                },
            },
        },
    });
    await expect(saveSettings({ tabGroupName: "Unsaved" })).rejects.toThrow("Storage unavailable");
    expect((await getSettings()).tabGroupName).toBe(DEFAULT_SETTINGS.tabGroupName);
});

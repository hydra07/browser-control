import { defineConfig } from "wxt";

const extensionIcons = {
    16: "icon/16.png",
    32: "icon/32.png",
    48: "icon/48.png",
    128: "icon/128.png",
} satisfies Record<16 | 32 | 48 | 128, string>;

// See https://wxt.dev/api/config.html
export default defineConfig({
    modulesDir: "wxt-modules",
    manifest: {
        name: "BrowserControl Agent",
        description: "AI Workspace extension for controlling browser via CDP",
        icons: extensionIcons,
        permissions: ["tabs", "tabGroups", "scripting", "debugger", "offscreen", "alarms", "storage"],
        host_permissions: ["<all_urls>"],
        // The workspace badge needs chrome.action even without a popup or panel.
        action: { default_icon: extensionIcons },
    },
    // Default template uses package.json's "name" verbatim
    // (@browsercontrol/extension -> "browsercontrolextension-....zip") — this
    // is just the {name} template variable, for a cleaner release asset name.
    zip: {
        name: "browsercontrol",
    },
});

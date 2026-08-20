import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // sidePanel is added automatically by having entrypoints/sidepanel/ —
  // the rest are permissions our own code actually calls (chrome.tabs,
  // chrome.debugger, chrome.scripting, chrome.offscreen), same set as the
  // hand-written manifest.json this replaces.
  manifest: {
    name: 'BrowserControl Agent',
    description: 'AI Workspace extension for controlling browser via CDP',
    permissions: ['tabs', 'tabGroups', 'scripting', 'debugger', 'offscreen', 'alarms', 'storage'],
    host_permissions: ['<all_urls>'],
    // chrome.action (used by lib/tabs.ts's toolbar badge, and required for
    // chrome.sidePanel.setPanelBehavior's "click icon -> open panel" to
    // have an icon to attach to) doesn't exist at all unless "action" is
    // in the manifest — WXT only adds it automatically for a popup
    // entrypoint, which we deliberately don't have (the toolbar icon opens
    // the side panel directly, not a popup). Empty object, no
    action: {},
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Ctrl+Shift+B',
          mac: 'Command+Shift+B',
        },
        description: 'Toggle BrowserControl Side Panel',
      },
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  // Default template uses package.json's "name" verbatim
  // (@browsercontrol/extension -> "browsercontrolextension-....zip") — this
  // is just the {name} template variable, for a cleaner release asset name.
  zip: {
    name: 'browsercontrol',
  },
});

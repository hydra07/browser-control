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
    permissions: ['tabs', 'tabGroups', 'scripting', 'debugger', 'offscreen'],
    host_permissions: ['<all_urls>'],
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

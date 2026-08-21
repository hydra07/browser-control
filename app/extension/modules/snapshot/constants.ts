export const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "menuitem",
    "treeitem",
    "tab",
    "slider",
]);

// Nested (not flat) so a field's label ends up as its sibling in the same
// `children` array — only worth the extra shape for browser_query_region,
// where scope is already small, not for a full-page snapshot.
export const MAX_REGION_NODES = 150;

/** Caps how many interactive elements handleVisualSnapshotCommand annotates+captures — one DOM.getBoxModel round trip per element. */
export const MAX_ANNOTATED = 40;

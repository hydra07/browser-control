export const HISTORY_LIMIT = 15;

/** Capped well past any realistic tab count — advisory state, not durable. */
export const MAX_TRACKED_TABS = 100;

export const INTERACTION_LIKE_EVALUATE = /\.value\s*=|\.click\(\)|\.checked\s*=|dispatchEvent/;

export const INTERACTIVE_CMDS = new Set(["click", "type", "press_key", "scroll", "drag"]);

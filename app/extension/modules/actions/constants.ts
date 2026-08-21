/** Pattern matching destructive button/link names to warn or block automated execution. */
export const RISKY_NAME_PATTERN =
    /delete|remove|uninstall|deactivate|cancel|unsubscribe|sign\s*out|log\s*out|pay|purchase|confirm|permanently/i;

/** Key definitions mapping key names to CDP dispatch parameters (key, code, keyCode). */
export const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
export const SUPPORTED_KEYS = Object.keys(KEY_DEFS);

/** Fallback mapping for punctuation and symbol keys on standard US keyboard layouts. */
export const SINGLE_CHAR_SYMBOL_CODES: Record<string, string> = {
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "`": "Backquote",
};

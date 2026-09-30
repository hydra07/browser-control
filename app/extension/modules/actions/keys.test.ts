import { describe, expect, test } from "bun:test";
import { parseKeyCombo } from "./index.js";

describe("key combos", () => {
    test("named keys and single characters carry the text they produce", () => {
        expect(parseKeyCombo("Enter")).toEqual({
            def: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
            modifiers: 0,
        });
        expect(parseKeyCombo("a")?.def.text).toBe("a");
    });

    test("modifiers set CDP bits and Shift upper-cases letters", () => {
        expect(parseKeyCombo("Control+a")?.modifiers).toBe(2);
        expect(parseKeyCombo("ctrl+shift+k")?.modifiers).toBe(10);
        expect(parseKeyCombo("Shift+a")?.def.key).toBe("A");
        expect(parseKeyCombo("Meta+Enter")?.modifiers).toBe(4);
        expect(parseKeyCombo("Control++")?.def.key).toBe("+");
    });

    test("unknown keys or modifiers are rejected", () => {
        expect(parseKeyCombo("Hyper+a")).toBeNull();
        expect(parseKeyCombo("NotAKey")).toBeNull();
    });
});

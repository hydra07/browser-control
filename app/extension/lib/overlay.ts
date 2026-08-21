// Visual feedback for click/type/press_key/scroll/navigate/switch_tab —
// cursor glide, ripple, native highlight, and bottom-dock badges/captions.
// Functions marked "self-contained" are injected into the PAGE via
// Runtime.evaluate (see evalOnPage in cdp.ts) and .toString()'d at the call
// site, so they run in the page's own JS realm and can't reference anything
// outside themselves — no shared consts/helpers, only literal duplication.
import { sendCommand, evalOnPage } from "./cdp.js";

export type ActionKind = "click" | "type";

/** Single source of truth for click=violet/type=cyan — self-contained functions duplicate these values by hand, kept in sync manually. */
export const KIND_COLORS: Record<
    ActionKind,
    { rgb: { r: number; g: number; b: number }; from: string; to: string }
> = {
    click: { rgb: { r: 99, g: 102, b: 241 }, from: "#a78bfa", to: "#6366f1" },
    type: { rgb: { r: 59, g: 130, b: 246 }, from: "#22d3ee", to: "#3b82f6" },
};

/** Self-contained. Glides a visible cursor dot to (x, y); `fast` shortens the glide for flow steps. */
export function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
    return new Promise((resolve) => {
        console.log("[browsercontrol] moveCursorTo", x, y, fast); // check the PAGE's own DevTools console if the cursor never appears
        if (!document.getElementById("__bc_cursor_style__")) {
            const style = document.createElement("style");
            style.id = "__bc_cursor_style__";
            style.textContent =
                "@keyframes __bc_halo__ { 0%,100% { transform: scale(0.82); opacity: .55; } 50% { transform: scale(1.15); opacity: .9; } }";
            document.documentElement.appendChild(style);
        }
        const durationS = fast ? 0.22 : 0.85;
        let cursor = document.getElementById(
            "__bc_cursor__",
        ) as HTMLDivElement | null;
        if (!cursor) {
            cursor = document.createElement("div");
            cursor.id = "__bc_cursor__";
            cursor.innerHTML =
                '<div style="position:absolute;left:0;top:0;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;background:radial-gradient(circle, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 72%);animation:__bc_halo__ 1.4s ease-in-out infinite;"></div>' +
                '<div data-bc-dot style="position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#6366f1);box-shadow:0 0 0 2px rgba(255,255,255,0.95),0 4px 12px rgba(99,102,241,0.6);transition:transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease;"></div>';
            document.documentElement.appendChild(cursor);
        }
        cursor.style.cssText = `all:initial;position:fixed;width:0;height:0;z-index:2147483647;pointer-events:none;left:${cursor.style.left || "-100px"};top:${cursor.style.top || "-100px"};transition:left ${durationS}s cubic-bezier(0.22,1,0.36,1),top ${durationS}s cubic-bezier(0.22,1,0.36,1);`;
        void cursor.offsetWidth; // flush layout so the transition animates from the current position
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
        setTimeout(resolve, fast ? 260 : 900);
    });
}

/** Self-contained. Squish-down/release on the cursor dot, timed to real mousedown/mouseup. */
export function pulseCursorPress(pressed: boolean) {
    const dot = document.querySelector(
        "#__bc_cursor__ [data-bc-dot]",
    ) as HTMLElement | null;
    if (dot) {
        if (pressed) {
            dot.style.transform = "scaleX(1.3) scaleY(0.75) translateY(2px)";
            dot.style.filter = "brightness(1.3)";
        } else {
            dot.style.transform = "scale(1)";
            dot.style.filter = "brightness(1)";
        }
    }
}

/** Self-contained. Ripple at the exact point a click/type/press_key input landed. */
export function showClickRipple(
    x: number,
    y: number,
    kind: "click" | "type",
    fast?: boolean,
) {
    if (!document.getElementById("__bc_ripple_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_ripple_style__";
        style.textContent = `
            @keyframes __bc_ring_out__ {
                0% { transform: scale(0.2); opacity: 1; border-width: 4px; }
                100% { transform: scale(1.2); opacity: 0; border-width: 0px; }
            }
            @keyframes __bc_core_pop__ {
                0% { transform: scale(0.5); opacity: 1; }
                40% { transform: scale(1.5); opacity: 1; }
                100% { transform: scale(0); opacity: 0; }
            }
        `;
        document.documentElement.appendChild(style);
    }
    const [a, b] =
        kind === "type" ? ["#22d3ee", "#3b82f6"] : ["#a78bfa", "#6366f1"];
    const wrap = document.createElement("div");
    wrap.style.cssText = `all:initial;position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:2147483647;pointer-events:none;`;
    document.documentElement.appendChild(wrap);
    const ringCount = fast ? 1 : 2;
    const ringDurationS = fast ? 0.35 : 0.6;
    for (let i = 0; i < ringCount; i++) {
        const ring = document.createElement("div");
        ring.style.cssText = `position:absolute;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:0px solid ${a};box-shadow:0 0 20px ${b}88;opacity:0;animation:__bc_ring_out__ ${ringDurationS}s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.1}s forwards;`;
        wrap.appendChild(ring);
    }
    const core = document.createElement("div");
    core.style.cssText = `position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:linear-gradient(135deg,${a},${b});box-shadow:0 0 15px 4px ${b}aa;animation:__bc_core_pop__ ${ringDurationS}s cubic-bezier(0.16, 1, 0.3, 1) forwards;`;
    wrap.appendChild(core);
    setTimeout(() => wrap.remove(), fast ? 450 : 800);
}

/** Native CDP highlight (Overlay.highlightRect) — immune to the page's own CSS/z-index, unlike a DOM-injected box. */
export async function showNativeHighlight(
    target: chrome.debugger.Debuggee,
    box: { x: number; y: number; w: number; h: number },
    rgb: { r: number; g: number; b: number },
): Promise<void> {
    await sendCommand(target, "Overlay.highlightRect", {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.w),
        height: Math.round(box.h),
        color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.2 },
        outlineColor: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.9 },
    });
}

export function hideNativeHighlight(target: chrome.debugger.Debuggee): void {
    void sendCommand(target, "Overlay.hideHighlight").catch(() => {});
}

/** A setTimeout that survives service-worker suspension (routed through a real CDP round trip instead of a bare JS timer). */
export function pageDelay(
    target: chrome.debugger.Debuggee,
    ms: number,
): Promise<void> {
    return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

/** Self-contained. Animated mouse+wheel badge showing scroll direction — scroll has no single element to point a cursor at. */
export function showScrollIndicator(
    deltaX: number,
    deltaY: number,
    fast?: boolean,
) {
    if (!document.getElementById("__bc_scroll_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_scroll_style__";
        style.textContent = `
            @keyframes __bc_scroll_pop__ {
                0% { transform: translateX(-50%) translateY(20px) scale(0.9); opacity: 0; }
                15% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
                85% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
                100% { transform: translateX(-50%) translateY(-20px) scale(0.9); opacity: 0; }
            }
            @keyframes __bc_scroll_wheel_down__ {
                0% { transform: translateY(-4px); opacity: 0; }
                20% { opacity: 1; }
                80% { opacity: 1; }
                100% { transform: translateY(12px); opacity: 0; }
            }
            @keyframes __bc_scroll_wheel_up__ {
                0% { transform: translateY(12px); opacity: 0; }
                20% { opacity: 1; }
                80% { opacity: 1; }
                100% { transform: translateY(-4px); opacity: 0; }
            }
            @keyframes __bc_scroll_wheel_right__ {
                0% { transform: translateX(-4px); opacity: 0; }
                20% { opacity: 1; }
                80% { opacity: 1; }
                100% { transform: translateX(12px); opacity: 0; }
            }
            @keyframes __bc_scroll_wheel_left__ {
                0% { transform: translateX(12px); opacity: 0; }
                20% { opacity: 1; }
                80% { opacity: 1; }
                100% { transform: translateX(-4px); opacity: 0; }
            }
        `;
        document.documentElement.appendChild(style);
    }
    const durationS = fast ? 0.6 : 1.2;
    const isVertical = Math.abs(deltaY) >= Math.abs(deltaX);
    const dir = isVertical ? (deltaY > 0 ? "down" : "up") : (deltaX > 0 ? "right" : "left");

    const badge = document.createElement("div");
    badge.style.cssText = `all:initial;position:fixed;left:50%;bottom:8%;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:26px;background:rgba(17,24,39,0.85);backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.3),inset 0 1px 1px rgba(255,255,255,0.15);animation:__bc_scroll_pop__ ${durationS}s cubic-bezier(0.16, 1, 0.3, 1) both;`;

    const mouse = document.createElement("div");
    mouse.style.cssText = `position:relative;width:22px;height:34px;border:2px solid rgba(255,255,255,0.8);border-radius:11px;box-sizing:border-box;`;

    const wheel = document.createElement("div");
    const animName = `__bc_scroll_wheel_${dir}__`;
    wheel.style.cssText = `position:absolute;left:50%;top:6px;width:4px;height:5px;margin-left:-2px;background:#fbbf24;border-radius:2px;box-shadow:0 0 8px rgba(251,191,36,0.8);animation:${animName} 0.6s infinite;`;

    mouse.appendChild(wheel);
    badge.appendChild(mouse);
    document.documentElement.appendChild(badge);
    setTimeout(() => badge.remove(), durationS * 1000 + 50);
}

// Every badge below docks to `position:fixed;left:50%;bottom:8%` — inlined
// into each function's own cssText rather than shared via a module-level
// const, since .toString()-ing a function only captures its own source
// text; a reference to an outside const evaluates to `undefined` once run
// in the page's JS realm instead of this module's.

/** Self-contained. 52px icon badge for press_key with no target element (browser_type -> Enter, no nodeId). Glyph-mapped for common keys. */
export function showKeyBadge(key: string, fast?: boolean) {
    if (!document.getElementById("__bc_key_badge_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_key_badge_style__";
        style.textContent =
            "@keyframes __bc_icon_badge_pop__ { 0% { transform: translateX(-50%) translateY(20px) scale(0.9); opacity: 0; } 15% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; } 85% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; } 100% { transform: translateX(-50%) translateY(-20px) scale(0.9); opacity: 0; } }";
        document.documentElement.appendChild(style);
    }
    const GLYPHS: Record<string, string> = {
        Enter: "⏎",
        Tab: "⇥",
        Escape: "⎋",
        Backspace: "⌫",
        Delete: "⌦",
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        " ": "␣",
        Home: "⇱",
        End: "⇲",
        PageUp: "⇞",
        PageDown: "⇟",
    };
    const glyph = GLYPHS[key];
    const durationS = fast ? 0.6 : 1.2;
    const badge = document.createElement("div");
    badge.style.cssText = `all:initial;position:fixed;left:50%;bottom:8%;z-index:2147483647;pointer-events:none;display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:26px;background:rgba(17,24,39,0.85);backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.3),inset 0 1px 1px rgba(255,255,255,0.15);animation:__bc_icon_badge_pop__ ${durationS}s cubic-bezier(0.16, 1, 0.3, 1) both;`;
    const label = document.createElement("div");
    label.style.cssText = glyph
        ? "color:#67e8f9;font:600 22px/1 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;text-shadow:0 0 10px rgba(34,211,238,0.7);"
        : "color:#67e8f9;font:600 11px/1.1 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;text-align:center;text-shadow:0 0 10px rgba(34,211,238,0.7);";
    label.textContent = glyph || key;
    badge.appendChild(label);
    document.documentElement.appendChild(badge);
    setTimeout(() => badge.remove(), durationS * 1000 + 50);
}

// Inline SVG markup for showPillCaption's `icon` param — built here, not
// injected, so ordinary shared consts are fine (unlike the self-contained
// functions above).
export const NAVIGATE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>';
export const SWITCH_TAB_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

/** Self-contained. Wider text pill for actions needing more than a glyph (navigate, switch_tab) — same bottom-dock anchor as showKeyBadge/showScrollIndicator. `icon` is inline SVG markup, `color`/`glow` a hex pair, per caller. */
export function showPillCaption(
    icon: string,
    text: string,
    color: string,
    glow: string,
    fast?: boolean,
) {
    if (!document.getElementById("__bc_pill_badge_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_pill_badge_style__";
        style.textContent =
            "@keyframes __bc_pill_badge_pop__ { 0% { transform: translateX(-50%) translateY(20px) scale(0.9); opacity: 0; } 15% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; } 85% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; } 100% { transform: translateX(-50%) translateY(-20px) scale(0.9); opacity: 0; } }";
        document.documentElement.appendChild(style);
    }
    const durationS = fast ? 0.8 : 1.6;
    const badge = document.createElement("div");
    badge.style.cssText = `all:initial;position:fixed;left:50%;bottom:8%;z-index:2147483647;pointer-events:none;display:flex;align-items:center;gap:8px;max-width:min(480px,84vw);padding:10px 18px 10px 14px;border-radius:999px;background:rgba(17,24,39,0.85);backdrop-filter:blur(12px);box-shadow:0 8px 32px rgba(0,0,0,0.3),inset 0 1px 1px rgba(255,255,255,0.15);animation:__bc_pill_badge_pop__ ${durationS}s cubic-bezier(0.16, 1, 0.3, 1) both;`;
    const iconEl = document.createElement("span");
    iconEl.style.cssText = `flex:none;display:flex;width:16px;height:16px;color:${color};filter:drop-shadow(0 0 6px ${glow}b3);`;
    iconEl.innerHTML = icon; // inline SVG markup, not an emoji glyph — see call sites
    const textEl = document.createElement("span");
    textEl.style.cssText = `color:${color};font:600 13.5px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 0 10px ${glow}80;`;
    textEl.textContent = text;
    badge.appendChild(iconEl);
    badge.appendChild(textEl);
    document.documentElement.appendChild(badge);
    setTimeout(() => badge.remove(), durationS * 1000 + 50);
}

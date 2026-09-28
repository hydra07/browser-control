/**
 * Injected visual feedback (cursor glide, click ripple, scroll/key badges) on live pages.
 */
import type { ActionLifecycleEvent, DriftKind, FlowAction } from "@browsercontrol/shared";
import { evalOnPage, sendCommand } from "../../libs/cdp.js";
import { subscribeActionLifecycle } from "../actions/events.js";

export type ActionKind = "click" | "type";

/** Single source of truth for native CDP highlight colors; page feedback uses the same neutral palette. */
export const KIND_COLORS: Record<ActionKind, { rgb: { r: number; g: number; b: number }; from: string; to: string }> = {
    click: { rgb: { r: 79, g: 70, b: 229 }, from: "#6366f1", to: "#4f46e5" },
    type: { rgb: { r: 37, g: 99, b: 235 }, from: "#3b82f6", to: "#2563eb" },
};

const ACTION_RUNNING_ICON =
    '<svg data-bc-spin="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
const ACTION_SUCCESS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';
const ACTION_FAILURE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>';
const ACTION_BLOCKED_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 4 9 16H3L12 4Z"/><path d="M12 9v5M12 17h.01"/></svg>';
const ACTION_REPAIR_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.5 7L20 9M4 15l1.5 2A7 7 0 0 0 17.9 15"/></svg>';

const ACTION_LABELS = {
    click: "Click",
    type: "Type",
    press_key: "Key press",
    wait_for: "Wait",
    assert_text: "Check text",
    scroll: "Scroll",
    drag: "Drag",
} as const satisfies Record<FlowAction, string>;

const DRIFT_LABELS = {
    SEMANTIC_REPAIR: "Repaired",
    TARGET_DRIFT: "Target changed",
    BEHAVIOR_DRIFT: "Behavior changed",
} as const satisfies Record<Exclude<DriftKind, "EXACT">, string>;

export interface ActionFeedback {
    icon: string;
    text: string;
    color: string;
    glow: string;
    fast: boolean;
    durationMs: number;
}

/** Maps immutable action events to short, privacy-safe visual feedback labels. */
export function getActionFeedback(event: ActionLifecycleEvent): ActionFeedback {
    const actionLabel = ACTION_LABELS[event.action];
    if (event.type === "action_started") {
        return {
            icon: ACTION_RUNNING_ICON,
            text: `${actionLabel} in progress`,
            color: "#c7d2fe",
            glow: "#6366f1",
            fast: true,
            durationMs: 30_000,
        };
    }

    if (event.result === "blocked") {
        return {
            icon: ACTION_BLOCKED_ICON,
            text: `${actionLabel} needs confirmation`,
            color: "#fcd34d",
            glow: "#f59e0b",
            fast: false,
            durationMs: 2_400,
        };
    }

    if (event.result === "failed") {
        const drift = event.drift && event.drift !== "EXACT" ? `${DRIFT_LABELS[event.drift]} · ` : "";
        return {
            icon: ACTION_FAILURE_ICON,
            text: `${drift}${actionLabel} failed`,
            color: "#fca5a5",
            glow: "#ef4444",
            fast: false,
            durationMs: 2_400,
        };
    }

    if (event.drift && event.drift !== "EXACT") {
        return {
            icon: event.drift === "SEMANTIC_REPAIR" ? ACTION_REPAIR_ICON : ACTION_FAILURE_ICON,
            text: `${DRIFT_LABELS[event.drift]} · ${actionLabel}`,
            color: event.drift === "SEMANTIC_REPAIR" ? "#93c5fd" : "#fcd34d",
            glow: event.drift === "SEMANTIC_REPAIR" ? "#3b82f6" : "#f59e0b",
            fast: false,
            durationMs: 2_000,
        };
    }

    return {
        icon: ACTION_SUCCESS_ICON,
        text: `${actionLabel} complete`,
        color: "#86efac",
        glow: "#22c55e",
        fast: false,
        durationMs: 1_400,
    };
}

/** Shows action progress and outcome through the same event stream used by evidence. */
export function installActionLifecycleOverlay(
    getTarget: (tabId: number) => chrome.debugger.Debuggee | null,
): () => void {
    return subscribeActionLifecycle((event) => {
        if (event.tabId == null) return;
        const target = getTarget(event.tabId);
        if (!target) return;
        const feedback = getActionFeedback(event);
        void evalOnPage(
            target,
            `(${showPillCaption.toString()})(${JSON.stringify(feedback.icon)}, ${JSON.stringify(feedback.text)}, ${JSON.stringify(feedback.color)}, ${JSON.stringify(feedback.glow)}, ${feedback.fast}, ${feedback.durationMs})`,
        ).catch(() => {});
    });
}

/** Self-contained. Glides a compact, neutral cursor dot to (x, y); `fast` shortens the glide for flow steps. */
export function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
    return new Promise((resolve) => {
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        if (!document.getElementById("__bc_overlay_style__")) {
            const style = document.createElement("style");
            style.id = "__bc_overlay_style__";
            style.textContent = `
                @keyframes __bc_cursor_breathe__ {
                    0%, 100% { transform: scale(.82); opacity: .42; }
                    50% { transform: scale(1); opacity: .72; }
                }
                #__bc_cursor__, #__bc_cursor__ * { pointer-events: none !important; }
                #__bc_cursor__ [data-bc-halo] {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 24px;
                    height: 24px;
                    margin: -12px 0 0 -12px;
                    border: 1px solid rgba(99, 102, 241, .48);
                    border-radius: 50%;
                    box-sizing: border-box;
                    animation: __bc_cursor_breathe__ 1.8s ease-in-out infinite;
                }
                #__bc_cursor__ [data-bc-dot] {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 9px;
                    height: 9px;
                    margin: -4.5px 0 0 -4.5px;
                    border: 1.5px solid rgba(255, 255, 255, .96);
                    border-radius: 50%;
                    box-sizing: border-box;
                    background: #4f46e5;
                    box-shadow: 0 2px 8px rgba(30, 41, 109, .5);
                    transition: transform .16s cubic-bezier(.34, 1.56, .64, 1), filter .16s ease;
                }
                @media (prefers-reduced-motion: reduce) {
                    #__bc_cursor__ [data-bc-halo],
                    #__bc_cursor__ [data-bc-dot] { animation: none !important; transition: none !important; }
                }
            `;
            document.documentElement.appendChild(style);
        }

        let cursor = document.getElementById("__bc_cursor__") as HTMLDivElement | null;
        if (!cursor) {
            cursor = document.createElement("div");
            cursor.id = "__bc_cursor__";
            cursor.innerHTML = "<span data-bc-halo></span><span data-bc-dot></span>";
            document.documentElement.appendChild(cursor);
        }

        const previousLeft = cursor.style.left || "-100px";
        const previousTop = cursor.style.top || "-100px";
        const durationMs = reducedMotion ? 0 : fast ? 180 : 560;
        cursor.style.cssText = `all:initial;position:fixed;left:${previousLeft};top:${previousTop};width:1px;height:1px;z-index:2147483647;pointer-events:none;transition:left ${durationMs}ms cubic-bezier(.22,1,.36,1),top ${durationMs}ms cubic-bezier(.22,1,.36,1);`;
        void cursor.offsetWidth;
        cursor.style.left = `${Math.round(x)}px`;
        cursor.style.top = `${Math.round(y)}px`;
        window.setTimeout(resolve, durationMs + 40);
    });
}

/** Self-contained. Squish-down/release on the cursor dot, timed to real mousedown/mouseup. */
export function pulseCursorPress(pressed: boolean): void {
    const dot = document.querySelector("#__bc_cursor__ [data-bc-dot]") as HTMLElement | null;
    if (!dot) return;
    dot.style.transform = pressed ? "scaleX(1.22) scaleY(.78) translateY(1px)" : "scale(1)";
    dot.style.filter = pressed ? "brightness(1.18)" : "brightness(1)";
}

/** Self-contained. Shows one compact ripple at the exact point a click/type input landed. */
export function showClickRipple(x: number, y: number, kind: "click" | "type", fast?: boolean): void {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!document.getElementById("__bc_ripple_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_ripple_style__";
        style.textContent = `
            @keyframes __bc_ripple_out__ {
                from { transform: scale(.25); opacity: .76; }
                to { transform: scale(1); opacity: 0; }
            }
            @keyframes __bc_ripple_core__ {
                from { transform: scale(.7); opacity: .9; }
                45% { transform: scale(1); opacity: .9; }
                to { transform: scale(.7); opacity: 0; }
            }
            .__bc_ripple_ring__,
            .__bc_ripple_core__ { pointer-events: none; }
            .__bc_ripple_ring__ {
                position: absolute;
                left: 0;
                top: 0;
                width: 42px;
                height: 42px;
                margin: -21px 0 0 -21px;
                border: 2px solid var(--bc-ripple-color);
                border-radius: 50%;
                box-sizing: border-box;
                box-shadow: 0 0 0 1px var(--bc-ripple-shadow);
                animation: __bc_ripple_out__ .42s cubic-bezier(.16,1,.3,1) forwards;
            }
            .__bc_ripple_core__ {
                position: absolute;
                left: 0;
                top: 0;
                width: 8px;
                height: 8px;
                margin: -4px 0 0 -4px;
                border-radius: 50%;
                background: var(--bc-ripple-color);
                box-shadow: 0 0 10px 2px var(--bc-ripple-shadow);
                animation: __bc_ripple_core__ .42s cubic-bezier(.16,1,.3,1) forwards;
            }
            @media (prefers-reduced-motion: reduce) {
                .__bc_ripple_ring__, .__bc_ripple_core__ { animation: none !important; opacity: .72; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    const color = kind === "type" ? "#3b82f6" : "#4f46e5";
    const shadow = kind === "type" ? "rgba(59,130,246,.45)" : "rgba(79,70,229,.45)";
    const wrap = document.createElement("div");
    wrap.style.cssText = `all:initial;--bc-ripple-color:${color};--bc-ripple-shadow:${shadow};position:fixed;left:${Math.round(x)}px;top:${Math.round(y)}px;width:1px;height:1px;z-index:2147483647;pointer-events:none;`;
    const ring = document.createElement("span");
    ring.className = "__bc_ripple_ring__";
    const core = document.createElement("span");
    core.className = "__bc_ripple_core__";
    wrap.append(ring, core);
    document.documentElement.appendChild(wrap);
    window.setTimeout(() => wrap.remove(), reducedMotion ? 100 : fast ? 300 : 520);
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
export function pageDelay(target: chrome.debugger.Debuggee, ms: number): Promise<void> {
    return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

/** Self-contained. Compact mouse badge showing scroll direction without adding a second status timeline. */
export function showScrollIndicator(deltaX: number, deltaY: number, fast?: boolean): void {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!document.getElementById("__bc_scroll_badge_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_scroll_badge_style__";
        style.textContent = `
            @keyframes __bc_transient_badge_in__ {
                from { opacity: 0; transform: translate(-50%, 8px) scale(.96); }
                to { opacity: 1; transform: translate(-50%, 0) scale(1); }
            }
            @keyframes __bc_transient_badge_out__ {
                from { opacity: 1; transform: translate(-50%, 0) scale(1); }
                to { opacity: 0; transform: translate(-50%, -6px) scale(.98); }
            }
            .__bc_transient_badge__ {
                all: initial;
                position: fixed;
                left: 50%;
                bottom: max(16px, env(safe-area-inset-bottom, 0px) + 16px);
                z-index: 2147483647;
                pointer-events: none;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 44px;
                height: 38px;
                border: 1px solid rgba(148, 163, 184, .32);
                border-radius: 12px;
                box-sizing: border-box;
                background: rgba(15, 23, 42, .94);
                box-shadow: 0 6px 20px rgba(15, 23, 42, .28);
                animation: __bc_transient_badge_in__ .18s ease-out both;
            }
            .__bc_transient_badge__ * { pointer-events: none; }
            .__bc_transient_badge__ [data-bc-badge-label] {
                color: #bfdbfe;
                font: 600 20px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            @keyframes __bc_scroll_wheel_down__ {
                from { transform: translateY(-3px); opacity: .2; }
                to { transform: translateY(8px); opacity: 1; }
            }
            @keyframes __bc_scroll_wheel_up__ {
                from { transform: translateY(8px); opacity: .2; }
                to { transform: translateY(-3px); opacity: 1; }
            }
            @keyframes __bc_scroll_wheel_right__ {
                from { transform: translateX(-3px); opacity: .2; }
                to { transform: translateX(8px); opacity: 1; }
            }
            @keyframes __bc_scroll_wheel_left__ {
                from { transform: translateX(8px); opacity: .2; }
                to { transform: translateX(-3px); opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
                .__bc_transient_badge__ { animation: none !important; }
                .__bc_transient_badge__ [data-bc-scroll-wheel] { animation: none !important; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    const overlayWindow = window as unknown as { __bcTransientBadgeTimer?: number };
    if (overlayWindow.__bcTransientBadgeTimer != null) window.clearTimeout(overlayWindow.__bcTransientBadgeTimer);
    document.getElementById("__bc_transient_badge__")?.remove();

    const isVertical = Math.abs(deltaY) >= Math.abs(deltaX);
    const direction = isVertical ? (deltaY >= 0 ? "down" : "up") : deltaX >= 0 ? "right" : "left";
    const badge = document.createElement("div");
    badge.id = "__bc_transient_badge__";
    badge.className = "__bc_transient_badge__";
    const mouse = document.createElement("span");
    mouse.style.cssText =
        "all:initial;position:relative;display:block;width:20px;height:28px;border:1.5px solid rgba(226,232,240,.82);border-radius:10px;box-sizing:border-box;";
    const wheel = document.createElement("span");
    wheel.dataset.bcScrollWheel = "true";
    wheel.style.cssText = `all:initial;position:absolute;left:50%;top:5px;width:3px;height:5px;margin-left:-1.5px;border-radius:2px;background:#60a5fa;animation:__bc_scroll_wheel_${direction}__ .5s ease-in-out infinite alternate;`;
    mouse.appendChild(wheel);
    badge.appendChild(mouse);
    document.documentElement.appendChild(badge);
    const durationMs = reducedMotion ? 700 : fast ? 650 : 1_100;
    overlayWindow.__bcTransientBadgeTimer = window.setTimeout(() => {
        badge.style.animation = reducedMotion ? "none" : "__bc_transient_badge_out__ .16s ease-in forwards";
        window.setTimeout(() => badge.remove(), reducedMotion ? 0 : 170);
    }, durationMs);
}

/** Self-contained. Compact key badge for press_key without a target element. */
export function showKeyBadge(key: string, fast?: boolean): void {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!document.getElementById("__bc_key_badge_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_key_badge_style__";
        style.textContent = `
            @keyframes __bc_transient_badge_in__ {
                from { opacity: 0; transform: translate(-50%, 8px) scale(.96); }
                to { opacity: 1; transform: translate(-50%, 0) scale(1); }
            }
            @keyframes __bc_transient_badge_out__ {
                from { opacity: 1; transform: translate(-50%, 0) scale(1); }
                to { opacity: 0; transform: translate(-50%, -6px) scale(.98); }
            }
            .__bc_transient_badge__ {
                all: initial;
                position: fixed;
                left: 50%;
                bottom: max(16px, env(safe-area-inset-bottom, 0px) + 16px);
                z-index: 2147483647;
                pointer-events: none;
                display: flex;
                align-items: center;
                justify-content: center;
                min-width: 44px;
                height: 38px;
                padding: 0 12px;
                border: 1px solid rgba(148, 163, 184, .32);
                border-radius: 12px;
                box-sizing: border-box;
                background: rgba(15, 23, 42, .94);
                box-shadow: 0 6px 20px rgba(15, 23, 42, .28);
                animation: __bc_transient_badge_in__ .18s ease-out both;
            }
            .__bc_transient_badge__ * { pointer-events: none; }
            .__bc_transient_badge__ [data-bc-badge-label] {
                color: #bfdbfe;
                font: 600 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                white-space: nowrap;
            }
            @media (prefers-reduced-motion: reduce) {
                .__bc_transient_badge__ { animation: none !important; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    const overlayWindow = window as unknown as { __bcTransientBadgeTimer?: number };
    if (overlayWindow.__bcTransientBadgeTimer != null) window.clearTimeout(overlayWindow.__bcTransientBadgeTimer);
    document.getElementById("__bc_transient_badge__")?.remove();

    const glyphs: Record<string, string> = {
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
    const label = document.createElement("span");
    label.dataset.bcBadgeLabel = "true";
    label.textContent = glyphs[key] || key.slice(0, 16);
    const badge = document.createElement("div");
    badge.id = "__bc_transient_badge__";
    badge.className = "__bc_transient_badge__";
    badge.appendChild(label);
    document.documentElement.appendChild(badge);
    const durationMs = reducedMotion ? 700 : fast ? 650 : 1_100;
    overlayWindow.__bcTransientBadgeTimer = window.setTimeout(() => {
        badge.style.animation = reducedMotion ? "none" : "__bc_transient_badge_out__ .16s ease-in forwards";
        window.setTimeout(() => badge.remove(), reducedMotion ? 0 : 170);
    }, durationMs);
}

export const NAVIGATE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>';
export const SWITCH_TAB_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

/** Self-contained. Replaces the previous status pill so rapid actions cannot stack stale feedback. */
export function showPillCaption(
    icon: string,
    text: string,
    color: string,
    glow: string,
    fast?: boolean,
    durationMs?: number,
): void {
    if (!document.getElementById("__bc_pill_badge_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_pill_badge_style__";
        style.textContent = `
            @keyframes __bc_pill_badge_in__ {
                from { opacity: 0; transform: translate(-50%, 8px) scale(.97); }
                to { opacity: 1; transform: translate(-50%, 0) scale(1); }
            }
            @keyframes __bc_pill_badge_out__ {
                from { opacity: 1; transform: translate(-50%, 0) scale(1); }
                to { opacity: 0; transform: translate(-50%, -5px) scale(.98); }
            }
            .__bc_pill_badge__ {
                all: initial;
                position: fixed;
                left: 50%;
                bottom: max(16px, env(safe-area-inset-bottom, 0px) + 16px);
                z-index: 2147483647;
                pointer-events: none;
                display: flex;
                align-items: center;
                gap: 8px;
                width: max-content;
                max-width: min(360px, calc(100vw - 32px));
                min-height: 34px;
                padding: 7px 12px 7px 10px;
                border: 1px solid var(--bc-pill-border);
                border-radius: 10px;
                box-sizing: border-box;
                background: rgba(15, 23, 42, .95);
                box-shadow: 0 7px 24px rgba(15, 23, 42, .3);
                animation: __bc_pill_badge_in__ .18s ease-out both;
            }
            .__bc_pill_badge__ [data-bc-pill-icon] {
                all: initial;
                flex: none;
                display: flex;
                width: 16px;
                height: 16px;
                color: var(--bc-pill-color);
            }
            .__bc_pill_badge__ [data-bc-pill-icon] svg {
                width: 16px;
                height: 16px;
            }
            .__bc_pill_badge__ [data-bc-spin] {
                transform-origin: center;
                animation: __bc_pill_spin__ .9s linear infinite;
            }
            @keyframes __bc_pill_spin__ { to { transform: rotate(360deg); } }
            .__bc_pill_badge__ [data-bc-pill-text] {
                all: initial;
                overflow: hidden;
                color: var(--bc-pill-color);
                font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                letter-spacing: .01em;
                text-overflow: ellipsis;
                white-space: nowrap;
                text-shadow: 0 0 10px var(--bc-pill-glow);
            }
            @media (prefers-reduced-motion: reduce) {
                .__bc_pill_badge__,
                .__bc_pill_badge__ [data-bc-spin] { animation: none !important; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    const safeColor = /^#[0-9a-f]{6}$/i.test(color) ? color : "#c7d2fe";
    const safeGlow = /^#[0-9a-f]{6}$/i.test(glow) ? glow : "#6366f1";
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const overlayWindow = window as unknown as { __bcPillTimer?: number };
    if (overlayWindow.__bcPillTimer != null) window.clearTimeout(overlayWindow.__bcPillTimer);
    document.getElementById("__bc_status_pill__")?.remove();

    const badge = document.createElement("div");
    badge.id = "__bc_status_pill__";
    badge.className = "__bc_pill_badge__";
    badge.style.setProperty("--bc-pill-color", safeColor);
    badge.style.setProperty("--bc-pill-glow", `${safeGlow}88`);
    badge.style.setProperty("--bc-pill-border", `${safeColor}55`);

    const iconEl = document.createElement("span");
    iconEl.dataset.bcPillIcon = "true";
    if (typeof icon === "string" && icon.length <= 1000 && /^<svg(?:\s|>)/i.test(icon)) iconEl.innerHTML = icon;

    const textEl = document.createElement("span");
    textEl.dataset.bcPillText = "true";
    textEl.textContent = text.slice(0, 120);
    badge.append(iconEl, textEl);
    document.documentElement.appendChild(badge);

    const visibleMs = durationMs ?? (fast ? 900 : 1_400);
    overlayWindow.__bcPillTimer = window.setTimeout(() => {
        badge.style.animation = reducedMotion ? "none" : "__bc_pill_badge_out__ .16s ease-in forwards";
        window.setTimeout(() => badge.remove(), reducedMotion ? 0 : 170);
    }, visibleMs);
}

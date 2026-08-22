/** In-page visual feedback for browser actions. */
import { evalOnPage, sendCommand } from "../../libs/cdp.js";

export type ActionKind = "click" | "type" | "key" | "scroll" | "drag" | "select" | "search";

export const KIND_COLORS: Record<string, { rgb: { r: number; g: number; b: number }; from: string; to: string }> = {
    click: { rgb: { r: 105, g: 177, b: 238 }, from: "#78bdf4", to: "#397cad" },
    type: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
    key: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
    enter: { rgb: { r: 98, g: 202, b: 154 }, from: "#7ad5aa", to: "#3b946d" },
    scroll: { rgb: { r: 183, g: 162, b: 113 }, from: "#cab785", to: "#927b4c" },
    drag: { rgb: { r: 105, g: 177, b: 238 }, from: "#78bdf4", to: "#397cad" },
    select: { rgb: { r: 128, g: 183, b: 220 }, from: "#8cc6e8", to: "#4e85a8" },
    search: { rgb: { r: 103, g: 194, b: 184 }, from: "#7acbc2", to: "#3f8f87" },
};

/** Moves the agent cursor and preserves a precise source-to-target trace. */
export function moveCursorTo(x: number, y: number, fast?: boolean): Promise<void> {
    return new Promise((resolve) => {
        if (!document.getElementById("__bc_cursor_style__")) {
            const style = document.createElement("style");
            style.id = "__bc_cursor_style__";
            style.textContent = `
                @keyframes __bc_trace_fade__{0%{opacity:.78}68%{opacity:.5}100%{opacity:0}}
                @keyframes __bc_origin_settle__{0%{opacity:0;transform:scale(.45)}35%{opacity:.8}100%{opacity:0;transform:scale(1.5)}}
                #__bc_cursor__ [data-bc-ring]{animation:__bc_cursor_idle__ 2.4s ease-in-out infinite}
                @keyframes __bc_cursor_idle__{0%,100%{opacity:.62;transform:scale(1)}50%{opacity:.28;transform:scale(1.18)}}
                @media(prefers-reduced-motion:reduce){#__bc_cursor__{transition:none!important}.bc-cursor-trace{display:none!important}}
            `;
            document.documentElement.appendChild(style);
        }

        const durationMs = fast ? 180 : 520;
        let cursor = document.getElementById("__bc_cursor__") as HTMLDivElement | null;
        if (!cursor) {
            cursor = document.createElement("div");
            cursor.id = "__bc_cursor__";
            cursor.innerHTML =
                '<div data-bc-ring style="position:absolute;left:-10px;top:-10px;width:20px;height:20px;border:1px solid rgba(132,199,250,.72);border-radius:50%;box-sizing:border-box;pointer-events:none"></div>' +
                '<div data-bc-dot style="position:absolute;left:-4px;top:-4px;width:8px;height:8px;border:1.5px solid rgba(255,255,255,.92);border-radius:50%;background:#4f9bd3;box-shadow:0 2px 6px rgba(0,0,0,.48),inset 0 1px rgba(255,255,255,.5);box-sizing:border-box;transition:transform 150ms cubic-bezier(.2,.9,.2,1),background 120ms ease;pointer-events:none"></div>';
            document.documentElement.appendChild(cursor);
        }

        const fromX = Number.parseFloat(cursor.style.left);
        const fromY = Number.parseFloat(cursor.style.top);
        if (Number.isFinite(fromX) && Number.isFinite(fromY) && fromX >= 0 && fromY >= 0) {
            const deltaX = x - fromX;
            const deltaY = y - fromY;
            const distance = Math.hypot(deltaX, deltaY);
            if (distance > 5) {
                const trace = document.createElement("div");
                trace.className = "bc-cursor-trace";
                trace.style.cssText = `all:initial;position:fixed;left:${fromX}px;top:${fromY}px;width:${distance}px;height:1px;z-index:2147483645;pointer-events:none;transform-origin:0 50%;transform:rotate(${Math.atan2(deltaY, deltaX)}rad);background:linear-gradient(90deg,rgba(115,181,232,.16),rgba(115,181,232,.68));animation:__bc_trace_fade__ ${fast ? 420 : 760}ms ease-out forwards;`;

                const origin = document.createElement("div");
                origin.className = "bc-cursor-trace";
                origin.style.cssText = `all:initial;position:fixed;left:${fromX - 3}px;top:${fromY - 3}px;width:6px;height:6px;z-index:2147483645;pointer-events:none;border:1px solid rgba(130,196,244,.7);border-radius:50%;box-sizing:border-box;animation:__bc_origin_settle__ ${fast ? 340 : 620}ms ease-out forwards;`;
                document.documentElement.append(trace, origin);
                setTimeout(
                    () => {
                        trace.remove();
                        origin.remove();
                    },
                    fast ? 460 : 800,
                );

                const traces = document.querySelectorAll(".bc-cursor-trace");
                for (let index = 0; index < traces.length - 8; index += 1) traces[index]?.remove();
            }
        }

        cursor.style.cssText = `all:initial;position:fixed;width:0;height:0;z-index:2147483647;pointer-events:none;left:${cursor.style.left || "-100px"};top:${cursor.style.top || "-100px"};transition:left ${durationMs}ms cubic-bezier(.22,1,.36,1),top ${durationMs}ms cubic-bezier(.22,1,.36,1);`;
        void cursor.offsetWidth;
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
        setTimeout(resolve, durationMs + 20);
    });
}

/** Squashes the cursor lens in sync with the real pointer state. */
export function pulseCursorPress(pressed: boolean): void {
    const dot = document.querySelector("#__bc_cursor__ [data-bc-dot]") as HTMLElement | null;
    const ring = document.querySelector("#__bc_cursor__ [data-bc-ring]") as HTMLElement | null;
    if (dot) {
        dot.style.transform = pressed ? "scale(1.45,.68)" : "scale(1)";
        dot.style.background = pressed ? "#d9efff" : "#4f9bd3";
    }
    if (ring) ring.style.transform = pressed ? "scale(.72,1.08)" : "scale(1)";
}

/** Shows a restrained lens-compression ripple at the target. */
export function showClickRipple(x: number, y: number, kind: "click" | "type" = "click", fast?: boolean): void {
    if (!document.getElementById("__bc_ripple_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_ripple_style__";
        style.textContent = `
            @keyframes __bc_ripple_outer__{0%{opacity:.9;transform:scale(.35)}100%{opacity:0;transform:scale(1.25)}}
            @keyframes __bc_ripple_core__{0%{opacity:.75;transform:scale(1)}50%{transform:scale(.55,1.25)}100%{opacity:0;transform:scale(.25)}}
        `;
        document.documentElement.appendChild(style);
    }
    const color = kind === "type" ? "111,199,190" : "111,183,239";
    const container = document.createElement("div");
    container.style.cssText = `all:initial;position:fixed;left:${x}px;top:${y}px;width:0;height:0;z-index:2147483647;pointer-events:none`;
    const ring = document.createElement("div");
    ring.style.cssText = `position:absolute;left:-18px;top:-18px;width:36px;height:36px;border:1.5px solid rgba(${color},.9);border-radius:50%;box-sizing:border-box;animation:__bc_ripple_outer__ ${fast ? 260 : 430}ms cubic-bezier(.16,1,.3,1) forwards`;
    const core = document.createElement("div");
    core.style.cssText = `position:absolute;left:-5px;top:-5px;width:10px;height:10px;border:1px solid rgba(255,255,255,.84);border-radius:50%;background:rgba(${color},.26);box-sizing:border-box;animation:__bc_ripple_core__ ${fast ? 220 : 360}ms ease-out forwards`;
    container.append(ring, core);
    document.documentElement.appendChild(container);
    setTimeout(() => container.remove(), fast ? 300 : 470);
}

/** Pulses the cursor lens for keyboard input without creating another badge. */
export function showKeyMotion(fast?: boolean): void {
    const cursor = document.getElementById("__bc_cursor__");
    const x = cursor ? Number.parseFloat(cursor.style.left) : window.innerWidth / 2;
    const y = cursor ? Number.parseFloat(cursor.style.top) : window.innerHeight / 2;
    const cue = document.createElement("div");
    cue.style.cssText = `all:initial;position:fixed;left:${Number.isFinite(x) ? x : window.innerWidth / 2}px;top:${Number.isFinite(y) ? y : window.innerHeight / 2}px;width:26px;height:14px;margin:-7px -13px;z-index:2147483646;pointer-events:none;border-top:1px solid rgba(119,205,194,.85);border-bottom:1px solid rgba(119,205,194,.52);border-radius:50%;box-sizing:border-box;opacity:.9;transform:scale(.5);transition:transform ${fast ? 180 : 300}ms cubic-bezier(.16,1,.3,1),opacity ${fast ? 180 : 300}ms ease`;
    document.documentElement.appendChild(cue);
    requestAnimationFrame(() => {
        cue.style.transform = "scale(1.35,.8)";
        cue.style.opacity = "0";
    });
    setTimeout(() => cue.remove(), fast ? 220 : 340);
}

/** Draws directional scroll motion near the pointer while the HUD owns the label. */
export function showScrollMotion(deltaX: number, deltaY: number, fast?: boolean): void {
    const cursor = document.getElementById("__bc_cursor__");
    const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
    const positive = (vertical ? deltaY : deltaX) >= 0;
    const x = cursor ? Number.parseFloat(cursor.style.left) : window.innerWidth / 2;
    const y = cursor ? Number.parseFloat(cursor.style.top) : window.innerHeight / 2;
    const cue = document.createElement("div");
    const axisTransform = vertical ? `translateY(${positive ? 18 : -18}px)` : `translateX(${positive ? 18 : -18}px)`;
    cue.style.cssText = `all:initial;position:fixed;left:${Number.isFinite(x) ? x : window.innerWidth / 2}px;top:${Number.isFinite(y) ? y : window.innerHeight / 2}px;width:${vertical ? 2 : 30}px;height:${vertical ? 30 : 2}px;margin:${vertical ? "-15px -1px" : "-1px -15px"};z-index:2147483646;pointer-events:none;border-radius:999px;background:linear-gradient(${vertical ? (positive ? "180deg" : "0deg") : positive ? "90deg" : "270deg"},transparent,rgba(197,177,126,.88));opacity:.88;transition:transform ${fast ? 210 : 380}ms cubic-bezier(.16,1,.3,1),opacity ${fast ? 210 : 380}ms ease`;
    document.documentElement.appendChild(cue);
    requestAnimationFrame(() => {
        cue.style.transform = axisTransform;
        cue.style.opacity = "0";
    });
    setTimeout(() => cue.remove(), fast ? 250 : 420);
}

/** Highlights a browser target outside the page's stacking contexts. */
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
        color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.12 },
        outlineColor: { r: rgb.r, g: rgb.g, b: rgb.b, a: 0.86 },
    });
}

export function hideNativeHighlight(target: chrome.debugger.Debuggee): void {
    void sendCommand(target, "Overlay.hideHighlight").catch(() => {});
}

/** Delays through a CDP round trip so service-worker suspension cannot interrupt it. */
export function pageDelay(target: chrome.debugger.Debuggee, ms: number): Promise<void> {
    return evalOnPage(target, `new Promise((r) => setTimeout(r, ${ms}))`, true);
}

/** Adds an action to the single top-center browser-control rail. */
export function showActionHud(action: string, title: string, detail?: string, fast?: boolean): void {
    if (!document.getElementById("__bc_hud_style__")) {
        const style = document.createElement("style");
        style.id = "__bc_hud_style__";
        style.textContent = `
            @keyframes __bc_rail_in__{0%{opacity:0;clip-path:inset(0 46% round 12px);transform:translateY(-8px) scale(.98)}100%{opacity:1;clip-path:inset(0 round 12px);transform:translateY(0) scale(1)}}
            @keyframes __bc_rail_out__{to{opacity:0;clip-path:inset(0 18% round 12px);transform:translateY(-7px) scale(.98)}}
            @keyframes __bc_rail_progress__{to{transform:scaleX(0)}}
            #__bc_activity_hud__{all:initial;position:fixed;top:14px;left:50%;z-index:2147483647;width:min(370px,calc(100vw - 24px));pointer-events:none;display:flex;flex-direction:column;gap:5px;transform:translateX(-50%);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
            #__bc_activity_hud__ .bc-hud-pill{all:initial;position:relative;display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:10px;min-height:46px;padding:6px 13px 6px 7px;overflow:hidden;border:1px solid rgba(224,239,255,.17);border-radius:13px;background:radial-gradient(circle at 26% -30%,rgba(190,224,255,.12),transparent 43%),rgba(9,14,21,.76);box-shadow:0 14px 34px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.13),inset 0 -1px rgba(0,0,0,.2);-webkit-backdrop-filter:blur(22px) saturate(125%);backdrop-filter:blur(22px) saturate(125%);box-sizing:border-box;animation:__bc_rail_in__ 300ms cubic-bezier(.16,1,.3,1) both;transition:opacity 180ms ease,transform 240ms cubic-bezier(.2,.8,.2,1)}
            #__bc_activity_hud__ .bc-hud-pill::after{position:absolute;inset:0;padding:1px;border-radius:inherit;background:linear-gradient(132deg,rgba(255,255,255,.2),transparent 31% 73%,rgba(79,151,211,.1));content:"";pointer-events:none;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
            #__bc_activity_hud__ .bc-hud-pill[data-history="true"]{opacity:.42;transform:scale(.965);min-height:34px}
            #__bc_activity_hud__ .bc-hud-pill[data-history="true"] .bc-hud-detail{display:none}
            #__bc_activity_hud__ .bc-hud-pill[data-exit="true"]{animation:__bc_rail_out__ 190ms ease-in forwards}
            #__bc_activity_hud__ .bc-hud-badge{all:initial;display:grid;width:38px;height:30px;place-items:center;border:1px solid rgba(195,224,250,.18);border-radius:9px;background:rgba(77,133,181,.14);color:#b9daf4;font:700 9px/1 ui-monospace,"SFMono-Regular",Consolas,monospace;letter-spacing:.05em;box-shadow:inset 0 1px rgba(255,255,255,.11);box-sizing:border-box}
            #__bc_activity_hud__ .bc-hud-content{all:initial;display:flex;min-width:0;flex-direction:column;gap:2px;font-family:inherit}
            #__bc_activity_hud__ .bc-hud-title{all:initial;overflow:hidden;color:#f3f6f9;font:620 12px/1.25 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-overflow:ellipsis;white-space:nowrap}
            #__bc_activity_hud__ .bc-hud-detail{all:initial;overflow:hidden;color:#8f9cac;font:550 9.5px/1.25 ui-monospace,"SFMono-Regular",Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}
            #__bc_activity_hud__ .bc-hud-bar{all:initial;position:absolute;right:0;bottom:0;left:0;height:2px;background:#69afe4;transform-origin:0 50%;animation:__bc_rail_progress__ var(--bc-duration) linear forwards}
            @media(prefers-reduced-motion:reduce){#__bc_activity_hud__ *{animation:none!important;transition:none!important}}
        `;
        document.documentElement.appendChild(style);
    }

    let root = document.getElementById("__bc_activity_hud__");
    if (!root) {
        root = document.createElement("div");
        root.id = "__bc_activity_hud__";
        document.documentElement.appendChild(root);
    }
    for (const previous of Array.from(root.children)) (previous as HTMLElement).dataset.history = "true";

    const codes: Record<string, string> = {
        click: "CLICK",
        type: "TYPE",
        enter: "ENTER",
        key: "KEY",
        scroll: "SCROLL",
        drag: "DRAG",
        search: "FIND",
        select: "SELECT",
        navigate: "GO",
        switch_tab: "TAB",
    };
    const durationMs = fast ? 900 : 1800;
    const pill = document.createElement("div");
    pill.className = "bc-hud-pill";
    pill.style.setProperty("--bc-duration", `${durationMs}ms`);

    const badge = document.createElement("div");
    badge.className = "bc-hud-badge";
    badge.textContent = codes[action] ?? action.slice(0, 6).toUpperCase();
    if (action === "enter") badge.style.color = "#aee0c6";
    else if (action === "scroll") badge.style.color = "#d8c18e";

    const content = document.createElement("div");
    content.className = "bc-hud-content";
    const titleElement = document.createElement("div");
    titleElement.className = "bc-hud-title";
    titleElement.textContent = title.trim().slice(0, 100);
    content.appendChild(titleElement);
    if (detail) {
        const detailElement = document.createElement("div");
        detailElement.className = "bc-hud-detail";
        detailElement.textContent = detail.trim().slice(0, 120);
        content.appendChild(detailElement);
    }
    const bar = document.createElement("div");
    bar.className = "bc-hud-bar";
    if (action === "enter") bar.style.background = "#69bf95";
    else if (action === "scroll") bar.style.background = "#b99d65";

    pill.append(badge, content, bar);
    root.prepend(pill);
    while (root.children.length > 3) root.lastElementChild?.remove();

    const hud = root;
    setTimeout(() => {
        pill.dataset.exit = "true";
        setTimeout(() => {
            pill.remove();
            if (hud.children.length === 0) hud.remove();
        }, 210);
    }, durationMs);
}

/** Reveals drag origin, destination, and progress on one precise trajectory. */
export function showDragTrajectory(points: Array<{ x: number; y: number }>, fast?: boolean): void {
    if (points.length < 2) return;
    document.getElementById("__bc_drag_path__")?.remove();

    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.id = "__bc_drag_path__";
    svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    svg.style.cssText =
        "all:initial;position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483645;pointer-events:none;overflow:visible";
    const pathData = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");

    const guide = document.createElementNS(namespace, "path");
    guide.setAttribute("d", pathData);
    guide.setAttribute("fill", "none");
    guide.setAttribute("stroke", "rgba(112,181,235,.28)");
    guide.setAttribute("stroke-width", "1.5");
    guide.setAttribute("stroke-linecap", "round");
    guide.setAttribute("stroke-linejoin", "round");
    guide.setAttribute("stroke-dasharray", "3 5");

    const progress = document.createElementNS(namespace, "path");
    progress.setAttribute("d", pathData);
    progress.setAttribute("fill", "none");
    progress.setAttribute("stroke", "#73b8ed");
    progress.setAttribute("stroke-width", "2");
    progress.setAttribute("stroke-linecap", "round");
    progress.setAttribute("stroke-linejoin", "round");

    const addMarker = (point: { x: number; y: number }, label: string, filled: boolean) => {
        const circle = document.createElementNS(namespace, "circle");
        circle.setAttribute("cx", `${point.x}`);
        circle.setAttribute("cy", `${point.y}`);
        circle.setAttribute("r", filled ? "5" : "4");
        circle.setAttribute("fill", filled ? "#73b8ed" : "rgba(8,14,21,.82)");
        circle.setAttribute("stroke", "rgba(210,235,255,.9)");
        circle.setAttribute("stroke-width", "1.5");
        const text = document.createElementNS(namespace, "text");
        text.setAttribute("x", `${point.x + 10}`);
        text.setAttribute("y", `${point.y - 7}`);
        text.setAttribute("fill", "rgba(196,222,243,.88)");
        text.setAttribute("font-family", "ui-monospace, SFMono-Regular, Consolas, monospace");
        text.setAttribute("font-size", "9");
        text.setAttribute("font-weight", "700");
        text.textContent = label;
        svg.append(circle, text);
    };

    svg.append(guide, progress);
    addMarker(points[0]!, "FROM", false);
    addMarker(points[points.length - 1]!, "TO", true);
    document.documentElement.appendChild(svg);

    const length = progress.getTotalLength();
    progress.style.strokeDasharray = `${length}`;
    progress.style.strokeDashoffset = `${length}`;
    progress.style.transition = `stroke-dashoffset ${fast ? 320 : 720}ms cubic-bezier(.16,1,.3,1)`;
    requestAnimationFrame(() => {
        progress.style.strokeDashoffset = "0";
    });

    setTimeout(
        () => {
            svg.style.transition = "opacity 240ms ease";
            svg.style.opacity = "0";
            setTimeout(() => svg.remove(), 250);
        },
        fast ? 1000 : 1750,
    );
}

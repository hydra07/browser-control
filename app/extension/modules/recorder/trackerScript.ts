/**
 * Injected in-page event listener for Auto-Flow Recording.
 * Injected via chrome.scripting.executeScript into the extension isolated world
 * with full access to chrome.runtime.sendMessage.
 */

export function attachFlowTrackerInPage(): void {
    const win = window as unknown as { __bcFlowTrackerInstalled?: boolean };
    if (win.__bcFlowTrackerInstalled) return;
    win.__bcFlowTrackerInstalled = true;

    function getBestSelector(el: Element | null): string {
        if (el?.nodeType !== 1) return "";
        if (el.id && !/\d{4,}/.test(el.id)) return `#${CSS.escape(el.id)}`;

        for (const attr of ["data-testid", "data-test", "name", "aria-label", "placeholder"]) {
            const val = el.getAttribute(attr);
            if (val) return `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
        }

        const role = el.getAttribute("role");
        if (role) return `${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`;

        const classes = Array.from(el.classList).filter((c) => !c.includes(":") && !/\d{4,}/.test(c));
        if (classes.length > 0) {
            return `${el.tagName.toLowerCase()}.${classes
                .slice(0, 2)
                .map((c) => CSS.escape(c))
                .join(".")}`;
        }

        return el.tagName.toLowerCase();
    }

    function getAccessibleInfo(el: Element | null): { role?: string; name?: string } {
        if (!el) return {};
        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        let name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
        if (!name && el.textContent) {
            name = el.textContent.trim().slice(0, 50);
        }
        return { role, name: name || undefined };
    }

    document.addEventListener(
        "click",
        (e) => {
            const target = e.target as Element | null;
            if (!target || target === document.body || target === document.documentElement) return;
            const selector = getBestSelector(target);
            const { role, name } = getAccessibleInfo(target);

            chrome.runtime
                .sendMessage({
                    target: "background",
                    type: "auto_flow_step",
                    step: {
                        action: "click",
                        selector: selector || undefined,
                        role: role || undefined,
                        name: name || undefined,
                    },
                })
                .catch(() => {});
        },
        true,
    );

    document.addEventListener(
        "input",
        (e) => {
            const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
            if (!target) return;
            const inputType = (target as HTMLInputElement).type?.toLowerCase();
            if (["checkbox", "radio", "button", "submit", "reset", "file"].includes(inputType)) return;

            const selector = getBestSelector(target);
            const { role, name } = getAccessibleInfo(target);
            const text = (target as HTMLInputElement).value ?? target.textContent ?? "";

            chrome.runtime
                .sendMessage({
                    target: "background",
                    type: "auto_flow_step",
                    step: {
                        action: "type",
                        selector: selector || undefined,
                        role: role || undefined,
                        name: name || undefined,
                        text: String(text),
                    },
                })
                .catch(() => {});
        },
        true,
    );

    document.addEventListener(
        "keydown",
        (e) => {
            if (["Enter", "Tab", "Escape"].includes(e.key)) {
                const target = e.target as Element | null;
                const selector = target ? getBestSelector(target) : undefined;
                const { role, name } = getAccessibleInfo(target);

                chrome.runtime
                    .sendMessage({
                        target: "background",
                        type: "auto_flow_step",
                        step: {
                            action: "press_key",
                            key: e.key,
                            selector: selector || undefined,
                            role: role || undefined,
                            name: name || undefined,
                        },
                    })
                    .catch(() => {});
            }
        },
        true,
    );
}

function browserControlAgent(request) {
    if (["point","focus","focused","scroll","guard"].includes(request.op)) {
        if (!(location.protocol === "https:" || location.protocol === "http:") || (request.origins?.length && !request.origins.some((value) => new URL(value).origin === location.origin))) throw new Error("session permission denied: page origin changed");
    }
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return node.isConnected && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const role = (node) => node.getAttribute("role") || ({ A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox", H1: "heading", H2: "heading", H3: "heading" }[node.tagName]) || (node.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", range: "slider" }[node.type] || "textbox") : "button");
    const sensitive = (node) => node.type === "password" || /password|secret|token|otp|one.time|credit.card|cc-number|cvv/i.test([node.name,node.id,node.autocomplete,node.getAttribute("aria-label")].join(" "));
    const name = (node) => {
        const labelled = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => node.ownerDocument.getElementById(id)?.textContent || "").join(" ");
        return normalize(node.getAttribute("aria-label") || labelled || (node.labels ? Array.from(node.labels, (label) => label.textContent).join(" ") : "") || node.getAttribute("placeholder") || node.getAttribute("alt") || node.innerText || node.title || (node.type === "submit" || node.type === "button" ? node.value : "")).slice(0,160);
    };
    const witness = (node) => {
        const row = node.closest("tr,[data-row-id],[data-key],[data-id]");
        return [role(node),name(node),row?.getAttribute("data-row-id"),row?.getAttribute("data-key"),row?.getAttribute("data-id"),normalize(row?.textContent).slice(0,500)].join("\u001f");
    };
    let state = globalThis.__browserControlDirect;
    if (!state || state.document !== document || state.next > 100000) {
        state = { document, epoch: request.seed, ids: new WeakMap(), refs: new Map(), next: 1 };
        globalThis.__browserControlDirect = state;
    }
    const resolve = () => {
        const numeric = /^(?:e)?[1-9]\d*$/.test(request.target || "");
        let node;
        if (numeric) {
            if (request.epoch !== state.epoch) throw new Error("stale_target: document changed; take a fresh snapshot");
            const entry = state.refs.get(Number(request.target.replace(/^e/,"")));
            node = entry?.node.deref();
            if (!node || !node.isConnected || entry.witness !== witness(node)) throw new Error("stale_target: node was replaced or changed; take a fresh snapshot");
        } else {
            const selector = (request.target || "").replace(/^css=/,"");
            const matches = document.querySelectorAll(selector);
            if (matches.length !== 1) throw new Error("target_ambiguous: CSS selector must match exactly one node");
            node = matches[0];
        }
        if (!visible(node) || node.disabled || node.getAttribute("aria-disabled") === "true") throw new Error("target_not_actionable: node is hidden, detached or disabled");
        return node;
    };
    if (request.op === "snapshot") {
        const nodes = [];
        const refs = new Map();
        const roots = [document];
        let scanned = 0;
        let truncated = false;
        for (let i = 0; i < roots.length; i++) {
            const walker = document.createTreeWalker(roots[i],NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
                if (++scanned > 20000 || nodes.length >= 2000 || roots.length > 256) { truncated = true; break; }
                if (node.shadowRoot) roots.push(node.shadowRoot);
                if (!node.matches("a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[tabindex]:not([tabindex='-1']),h1,h2,h3") || !visible(node)) continue;
                let id = state.ids.get(node);
                if (!id) { id = state.next++; state.ids.set(node,id); }
                refs.set(id,{ node: new WeakRef(node), witness: witness(node) });
                nodes.push({ id, role: role(node), name: name(node), value: sensitive(node) ? "[REDACTED]" : normalize(node.value).slice(0,160), disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true" });
            }
            if (truncated) break;
        }
        state.refs = refs;
        return { documentId: state.epoch, url: location.href, title: document.title, nodes, truncated, coverage: "main_document_and_open_shadow_roots; child_frames_not_collected; snapshot_at" };
    }
    if (request.op === "ready") return document.readyState === "complete";
    if (request.op === "guard") return true;
    if (request.op === "read") return (document.body?.innerText || "").slice(0,request.maxChars);
    if (request.op === "wait") {
        const query = request.text || "";
        if (/^(css=|#|\.|\[)/.test(query)) return Array.from(document.querySelectorAll(query.replace(/^css=/,""))).some(visible);
        return (document.body?.innerText || "").includes(query);
    }
    if (request.op === "scroll") { window.scrollBy(request.x || 0,request.y || 0); return { ok: true }; }
    const node = resolve();
    if (request.op === "focus") {
        if (node.readOnly || !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable)) throw new Error("target_not_editable");
        node.focus({ preventScroll: true });
        if (request.clear) {
            if (typeof node.select === "function") node.select();
            else { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
        }
        return { ok: document.activeElement === node || node.getRootNode().activeElement === node };
    }
    if (request.op === "focused") return { ok: document.activeElement === node || node.getRootNode().activeElement === node };
    if (request.op === "point") {
        node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const rect = node.getBoundingClientRect();
        const x = Math.max(0,Math.min(innerWidth-1,rect.x+rect.width/2));
        const y = Math.max(0,Math.min(innerHeight-1,rect.y+rect.height/2));
        const hit = node.getRootNode().elementFromPoint(x,y);
        if (!hit || !(hit === node || node.contains(hit))) throw new Error("target_occluded: another element covers the click point");
        return { x,y };
    }
    throw new Error("unsupported agent request");
}

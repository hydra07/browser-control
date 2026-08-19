// Deep-dive on one element by nodeId: outerHTML, matched/computed CSS,
// event listeners — deliberately expensive relative to browser_snapshot,
// which shows almost nothing per element to stay cheap across a whole page.
import { sendCommand } from "./cdp.js";

const RELEVANT_STYLE_PROPS = new Set([
    "display",
    "position",
    "top",
    "left",
    "right",
    "bottom",
    "width",
    "height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "color",
    "background-color",
    "border",
    "border-radius",
    "font-size",
    "font-weight",
    "line-height",
    "opacity",
    "visibility",
    "z-index",
    "overflow",
    "flex-direction",
    "justify-content",
    "align-items",
]);

const MAX_HTML_CHARS = 5000;

export async function inspectElement(
    target: chrome.debugger.Debuggee,
    backendNodeId: number,
): Promise<Record<string, unknown>> {
    const describeResult = await sendCommand(target, "DOM.describeNode", {
        backendNodeId,
    }).catch(() => null);

    if (!describeResult?.node) {
        return {
            error: "Failed to resolve node",
            hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot and retry.",
        };
    }

    const [outerHTMLResult, pushResult, resolveResult] = await Promise.all([
        sendCommand(target, "DOM.getOuterHTML", { backendNodeId }).catch(
            () => null,
        ),
        sendCommand(target, "DOM.pushNodesByBackendIdsToFrontend", {
            backendNodeIds: [backendNodeId],
        }).catch(() => null),
        sendCommand(target, "DOM.resolveNode", { backendNodeId }).catch(
            () => null,
        ),
    ]);

    let outerHTML: string | undefined = outerHTMLResult?.outerHTML;
    let outerHTMLTruncated = false;
    if (typeof outerHTML === "string" && outerHTML.length > MAX_HTML_CHARS) {
        outerHTML = outerHTML.slice(0, MAX_HTML_CHARS);
        outerHTMLTruncated = true;
    }

    // CSS domain methods need a session-scoped nodeId (from wave 1's push),
    // not backendNodeId. DOMDebugger needs resolveNode's objectId.
    const nodeId = pushResult?.nodeIds?.[0];
    const objectId = resolveResult?.object?.objectId;

    // Fallback outerHTML if DOM.getOuterHTML failed
    if (!outerHTML && objectId) {
        const evalRes = await sendCommand(target, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function() { return this.outerHTML; }",
            returnByValue: true,
        }).catch(() => null);
        if (evalRes?.result?.value) {
            outerHTML = evalRes.result.value;
            if (typeof outerHTML === "string" && outerHTML.length > MAX_HTML_CHARS) {
                outerHTML = outerHTML.slice(0, MAX_HTML_CHARS);
                outerHTMLTruncated = true;
            }
        }
    }

    const [matchedResult, computedResult, listenersResult] = await Promise.all([
        nodeId != null
            ? sendCommand(target, "CSS.getMatchedStylesForNode", { nodeId }).catch(() => null)
            : Promise.resolve(null),
        nodeId != null
            ? sendCommand(target, "CSS.getComputedStyleForNode", { nodeId }).catch(() => null)
            : Promise.resolve(null),
        objectId
            ? sendCommand(target, "DOMDebugger.getEventListeners", { objectId }).catch(() => null)
            : Promise.resolve(null),
    ]);

    const matchedRules = (matchedResult?.matchedCSSRules || [])
        .slice(0, 15)
        .map((m) => ({
            selector: m.rule?.selectorList?.text,
            origin: m.rule?.origin,
            properties: Object.fromEntries(
                (m.rule?.style?.cssProperties || [])
                    .filter((p) => !p.disabled)
                    .map((p) => [p.name, p.value]),
            ),
        }));

    const computedStyle: Record<string, string> = {};
    for (const prop of computedResult?.computedStyle || []) {
        if (RELEVANT_STYLE_PROPS.has(prop.name))
            computedStyle[prop.name] = prop.value;
    }

    const eventListeners = (listenersResult?.listeners || []).map((l) => ({
        type: l.type,
        useCapture: l.useCapture,
        passive: l.passive,
        once: l.once,
    }));
    if (objectId)
        void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(
            () => {},
        );

    return {
        nodeName: describeResult.node.nodeName,
        attributes: describeResult.node.attributes,
        outerHTML,
        outerHTMLTruncated,
        matchedRules,
        computedStyle,
        eventListeners,
    };
}

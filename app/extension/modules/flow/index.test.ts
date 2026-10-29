import { beforeEach, describe, expect, test } from "bun:test";
import type { FlowStepV2 } from "@browsercontrol/shared";
import { performType } from "../actions/index.js";
import { runFlowSteps } from "./index.js";

let actualName = "Save";
let actualRole = "button";
let mouseEvents = 0;
let inserts = 0;
let field = "";
let selected = false;
let uppercase = false;
let swallowInput = false;
let assertionChecks = 0;
let assertionAfter = Infinity;
let cancelAfterMouse: AbortController | undefined;

beforeEach(() => {
    actualName = "Save";
    actualRole = "button";
    mouseEvents = 0;
    inserts = 0;
    field = "";
    selected = false;
    uppercase = false;
    swallowInput = false;
    assertionChecks = 0;
    assertionAfter = Infinity;
    cancelAfterMouse = undefined;
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            runtime: { lastError: undefined },
            debugger: {
                sendCommand(
                    _target: unknown,
                    method: string,
                    params: Record<string, unknown>,
                    callback: (result: unknown) => void,
                ) {
                    let result: unknown = {};
                    if (method === "Accessibility.getFullAXTree" || method === "Accessibility.queryAXTree")
                        result = {
                            nodes: [
                                {
                                    nodeId: "one",
                                    backendDOMNodeId: 42,
                                    role: { value: actualRole },
                                    name: { value: actualName },
                                },
                            ],
                        };
                    if (method === "DOM.getDocument") result = { root: { nodeId: 1 } };
                    if (method === "DOM.querySelectorAll") result = { nodeIds: [2] };
                    if (method === "DOM.describeNode") result = { node: { backendNodeId: 42 } };
                    if (method === "DOM.resolveNode") result = { object: { objectId: "field" } };
                    if (method === "DOM.getBoxModel") result = { model: { content: [0, 0, 20, 0, 20, 20, 0, 20] } };
                    if (method === "Page.getLayoutMetrics")
                        result = { cssLayoutViewport: { clientWidth: 500, clientHeight: 500 } };
                    if (method === "Page.getFrameTree")
                        result = {
                            frameTree: { frame: { url: "https://fixture.test/", id: "main", loaderId: "one" } },
                        };
                    if (method === "Runtime.callFunctionOn") {
                        const expression = String(params.functionDeclaration);
                        if (expression.includes("this.selectionStart")) {
                            const argument = (params.arguments as Array<{ value: string }>)[0]?.value ?? "";
                            result = { result: { value: field + argument } };
                        } else if (expression.includes("this.select")) {
                            selected = true;
                            result = { result: { value: true } };
                        } else result = { result: { value: expression.includes("this.value") ? field : null } };
                    }
                    if (method === "Runtime.evaluate") {
                        const isAssertion = String(params.expression).includes("document.body?.innerText?.includes");
                        result = { result: { value: isAssertion ? ++assertionChecks >= assertionAfter : "dom_quiet" } };
                    }
                    if (method === "Input.insertText") {
                        inserts++;
                        const text = uppercase ? String(params.text).toUpperCase() : String(params.text);
                        if (!swallowInput) field = selected ? text : field + text;
                        selected = false;
                    }
                    if (method === "Input.dispatchKeyEvent" && params.key === "Delete" && selected) {
                        field = "";
                        selected = false;
                    }
                    if (method === "Input.dispatchMouseEvent") {
                        mouseEvents++;
                        cancelAfterMouse?.abort();
                    }
                    callback(result);
                },
            },
            tabs: { onUpdated: { addListener() {}, removeListener() {} } },
        },
    });
});

function run(steps: FlowStepV2[], signal?: AbortSignal) {
    return runFlowSteps({ tabId: 1 }, steps, { captureEachStep: false, signal, runId: "test-run" });
}

describe("workflow safety regressions", () => {
    test("validates every step before executing the first", async () => {
        const report = await run([
            { action: "click", selector: "#save" },
            { action: "unknown" } as unknown as FlowStepV2,
        ]);
        expect(report.reason).toBe("invalid_flow");
        expect(mouseEvents).toBe(0);
    });
    test("stops selector matches whose role/name constraints changed", async () => {
        const report = await run([{ action: "click", selector: "#save", role: "textbox", name: "Email" }]);
        expect(report.reason).toBe("target_drift");
        expect(mouseEvents).toBe(0);
    });
    test("semantic repairs require an explicit repair policy", async () => {
        actualName = "Save draft now";
        const report = await run([
            { action: "click", role: "button", name: "Save draft", policy: { onDrift: "stop" } },
        ]);
        expect(report.success).toBe(false);
        expect(mouseEvents).toBe(0);
    });
    test("risk checks inspect the actual repaired name", async () => {
        actualName = "Save draft pay";
        const report = await run([
            { action: "click", role: "button", name: "Save draft", policy: { onDrift: "repair" } },
        ]);
        expect(report.reason).toBe("risky_action_blocked");
        expect(mouseEvents).toBe(0);
    });
    test("report drift never converts a failed assertion to overall success", async () => {
        const report = await run([
            {
                action: "click",
                selector: "#save",
                expected: { kind: "text", contains: "done" },
                policy: { onDrift: "report", timeoutMs: 2 },
            },
        ]);
        expect(report.steps[0]?.success).toBe(false);
        expect(report.success).toBe(false);
    });
    test("polls a delayed expected transition instead of failing immediately", async () => {
        assertionAfter = 2;
        const report = await run([
            { action: "click", selector: "#save", expected: { kind: "text", contains: "done" } },
        ]);
        expect(report.success).toBe(true);
        expect(report.verified).toBe(true);
        expect(assertionChecks).toBe(2);
    });
    test("fill replaces recorded full values instead of appending", async () => {
        field = "abc";
        const report = await run([{ action: "fill", selector: "#search", text: "abc" }]);
        expect(report.success).toBe(true);
        expect(field).toBe("abc");
        expect(inserts).toBe(1);
    });
    test("transformed input is not automatically inserted a second time", async () => {
        uppercase = true;
        const report = await performType({ tabId: 1 }, 42, "x", { fast: true });
        expect("error" in report).toBe(true);
        expect(field).toBe("X");
        expect(inserts).toBe(1);
    });
    test("pre-existing matching text cannot mask swallowed keystrokes", async () => {
        field = "abc";
        swallowInput = true;
        const result = await performType({ tabId: 1 }, 42, "abc", { fast: true });
        expect("error" in result).toBe(true);
        expect(inserts).toBe(1);
        expect(field).toBe("abc");
    });
    test("cancellation prevents the next step, without replaying the previous action", async () => {
        cancelAfterMouse = new AbortController();
        const report = await run(
            [
                { action: "click", selector: "#save" },
                { action: "click", selector: "#next" },
            ],
            cancelAfterMouse.signal,
        );
        expect(report.reason).toBe("timeout");
        expect(report.steps).toHaveLength(1);
        expect(mouseEvents).toBe(3);
    });
    test("distinguishes dispatched actions from verified outcomes", async () => {
        const report = await run([{ action: "click", selector: "#save" }]);
        expect(report.success).toBe(true);
        expect(report.verified).toBe(false);
        expect(report.runId).toBe("test-run");
    });
});

import { afterEach, expect, mock, test } from "bun:test";
import { type DispatchCtx, dispatchCommand } from "./index";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
    Object.defineProperty(globalThis, "chrome", originalChrome ?? { configurable: true, value: undefined });
});

test("recorder status and stop work without a browser tab or debugger attachment", async () => {
    const query = mock(async () => {
        throw new Error("No browser tabs available");
    });
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { tabs: { query } } });
    const attach = mock(async () => {
        throw new Error("Debugger must not be attached");
    });
    const lastTab = mock(() => null);
    const ctx = {
        getLastActiveTabId: lastTab,
        setLastActiveTabId() {},
        attachDebuggerIfNeeded: attach,
        extensionVersion: "test",
    } satisfies DispatchCtx;
    const summary = await dispatchCommand({ cmd: "flow_recording_status", summary: true }, ctx);
    expect(summary).toEqual({ isRecording: false, stepCount: 0 });
    const full = await dispatchCommand({ cmd: "flow_recording_status" }, ctx);
    expect(full.steps).toEqual([]);
    const stopped = await dispatchCommand({ cmd: "stop_flow_recording" }, ctx);
    expect(stopped.stepCount).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(lastTab).not.toHaveBeenCalled();
});

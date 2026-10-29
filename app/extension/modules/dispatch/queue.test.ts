import { expect, test } from "bun:test";
import { CommandQueue } from "./queue.js";

test("serializes work, cancels queued requests and remains usable after failures", async () => {
    const queue = new CommandQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const events: string[] = [];
    const first = queue.run("one", undefined, async () => {
        events.push("one");
        await gate;
    });
    const second = queue.run("two", undefined, async () => {
        events.push("two");
    });
    const outcome = second.catch((error: unknown) => error);
    queue.cancel("two");
    release();
    await first;
    expect(String(await outcome)).toContain("cancelled");
    await queue.run("three", undefined, async () => {
        events.push("three");
    });
    expect(events).toEqual(["one", "three"]);
});

test("does not dispatch expired or duplicate requests", async () => {
    const queue = new CommandQueue();
    let calls = 0;
    await expect(
        queue.run("expired", Date.now() - 1, async () => {
            calls++;
        }),
    ).rejects.toThrow("expired");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const first = queue.run("same", undefined, () => gate);
    await expect(
        queue.run("same", undefined, async () => {
            calls++;
        }),
    ).rejects.toThrow("Duplicate");
    release();
    await first;
    expect(calls).toBe(0);
});

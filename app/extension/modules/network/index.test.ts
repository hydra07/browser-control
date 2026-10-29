import { expect, test } from "bun:test";
import { NetworkCollector, redactNetworkUrl } from "./index.js";

test("isolates identical request ids by tab and clears only the selected tab", async () => {
    let listener!: (source: { tabId: number }, method: string, params: unknown) => void;
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            debugger: {
                onEvent: {
                    addListener(callback: typeof listener) {
                        listener = callback;
                    },
                    removeListener() {},
                },
            },
        },
    });
    const collector = new NetworkCollector();
    collector.install();
    for (const tabId of [1, 2])
        listener({ tabId }, "Network.requestWillBeSent", {
            requestId: "same",
            type: "Fetch",
            request: { url: `https://example.test/${tabId}`, method: "GET" },
        });
    expect(collector.list({ tabId: 1 })).toHaveLength(1);
    expect(collector.list({ tabId: 2 })[0]?.url).toBe("https://example.test/2");
    expect(collector.list({ tabId: 1 })[0]?.timestamp).toBeGreaterThan(0);
    collector.clear(1);
    expect(collector.list({ tabId: 1 })).toHaveLength(0);
    expect(collector.list({ tabId: 2 })).toHaveLength(1);
    expect((await collector.getDetail({ tabId: 1 }, "same")).error).toBe("Unknown requestId");
});

test("redacts credential-like URL query and authority fields", () => {
    const value = redactNetworkUrl("https://user:password@example.test/a?token=secret&query=hello");
    expect(value).not.toContain("secret");
    expect(value).not.toContain("password");
    expect(value).not.toContain("user:");
    expect(value).toContain("query=hello");
});

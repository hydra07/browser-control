import type { Protocol } from "devtools-protocol";
import { sendCommand, errorMessage } from "./cdp.js";
import { listNetworkRequests } from "./network.js";

// ============================================================================
// 1. Memory & Heap Diagnostics
// ============================================================================

export interface MemoryMetricsReport {
    summary: {
        jsHeapUsedMb: number;
        jsHeapTotalMb: number;
        jsHeapPercent: number;
        domNodes: number;
        documents: number;
        jsEventListeners: number;
        gcPressure: "low" | "moderate" | "high";
    };
    details?: Record<string, unknown>;
}

export async function handleInspectMemory(
    target: chrome.debugger.Debuggee,
    opts: { focus?: "overview" | "dom" | "listeners" | "gc" } = {},
): Promise<Record<string, unknown>> {
    try {
        await sendCommand(target, "Performance.enable").catch(() => {});
        const [perfRes, domCounters] = await Promise.all([
            sendCommand(target, "Performance.getMetrics").catch(() => null),
            sendCommand(target, "Memory.getDOMCounters").catch(() => null),
        ]);

        const metricsMap = new Map<string, number>();
        if (perfRes?.metrics) {
            for (const m of perfRes.metrics) {
                metricsMap.set(m.name, m.value);
            }
        }

        const jsHeapUsed = metricsMap.get("JSHeapUsedSize") ?? 0;
        const jsHeapTotal = metricsMap.get("JSHeapTotalSize") ?? 0;
        const jsHeapUsedMb = Number((jsHeapUsed / (1024 * 1024)).toFixed(2));
        const jsHeapTotalMb = Number((jsHeapTotal / (1024 * 1024)).toFixed(2));
        const jsHeapPercent = jsHeapTotalMb > 0 ? Math.round((jsHeapUsedMb / jsHeapTotalMb) * 100) : 0;

        const domNodes = domCounters?.nodes ?? metricsMap.get("Nodes") ?? 0;
        const documents = domCounters?.documents ?? metricsMap.get("Documents") ?? 1;
        const jsEventListeners = domCounters?.jsEventListeners ?? metricsMap.get("JSEventListeners") ?? 0;

        const gcPressure: "low" | "moderate" | "high" =
            jsHeapPercent > 85 || domNodes > 15000 ? "high" : jsHeapPercent > 70 || domNodes > 6000 ? "moderate" : "low";

        const summary = {
            jsHeapUsedMb,
            jsHeapTotalMb,
            jsHeapPercent,
            domNodes,
            documents,
            jsEventListeners,
            gcPressure,
        };

        const focus = opts.focus ?? "overview";
        if (focus === "overview") {
            return {
                message: `[Memory] Heap: ${jsHeapUsedMb}MB / ${jsHeapTotalMb}MB (${jsHeapPercent}%) | DOM Nodes: ${domNodes} | Listeners: ${jsEventListeners} | GC Pressure: ${gcPressure.toUpperCase()}`,
                ...summary,
            };
        }

        // Drill down focus
        let details: Record<string, unknown> = {};
        if (focus === "dom") {
            // Find top container elements with largest child counts
            const evalRes = await sendCommand(target, "Runtime.evaluate", {
                expression: `(() => {
                    const elements = Array.from(document.querySelectorAll('*'));
                    const topContainers = elements
                        .map(el => ({ tag: el.tagName.toLowerCase(), id: el.id, className: el.className ? String(el.className).slice(0, 50) : undefined, childrenCount: el.children.length }))
                        .filter(e => e.childrenCount > 10)
                        .sort((a, b) => b.childrenCount - a.childrenCount)
                        .slice(0, 8);
                    return { totalElements: elements.length, topContainers };
                })()`,
                returnByValue: true,
            }).catch(() => null);
            details = (evalRes?.result?.value as Record<string, unknown>) ?? {};
        } else if (focus === "listeners") {
            details = {
                message: `Active event listeners count: ${jsEventListeners}. High listener counts (>500) may indicate unremoved event listeners on component unmounts.`,
                totalListeners: jsEventListeners,
            };
        } else if (focus === "gc") {
            // Trigger garbage collection
            await sendCommand(target, "HeapProfiler.collectGarbage").catch(() => {});
            details = { message: "Triggered V8 garbage collection (HeapProfiler.collectGarbage)." };
        }

        return {
            summary,
            focus,
            details,
        };
    } catch (e) {
        return {
            error: `Failed to inspect memory: ${errorMessage(e)}`,
        };
    }
}

// ============================================================================
// 2. Process & Rendering / CPU Performance
// ============================================================================

export async function handleInspectProcess(
    target: chrome.debugger.Debuggee,
    opts: { focus?: "overview" | "long_tasks" | "rendering" } = {},
): Promise<Record<string, unknown>> {
    try {
        await sendCommand(target, "Performance.enable").catch(() => {});
        const perfRes = await sendCommand(target, "Performance.getMetrics").catch(() => null);

        const metricsMap = new Map<string, number>();
        if (perfRes?.metrics) {
            for (const m of perfRes.metrics) {
                metricsMap.set(m.name, m.value);
            }
        }

        const taskDurationMs = Math.round((metricsMap.get("TaskDuration") ?? 0) * 1000);
        const scriptDurationMs = Math.round((metricsMap.get("ScriptDuration") ?? 0) * 1000);
        const layoutDurationMs = Math.round((metricsMap.get("LayoutDuration") ?? 0) * 1000);
        const recalcStyleDurationMs = Math.round((metricsMap.get("RecalcStyleDuration") ?? 0) * 1000);
        const layoutCount = metricsMap.get("LayoutCount") ?? 0;
        const recalcStyleCount = metricsMap.get("RecalcStyleCount") ?? 0;

        // Long tasks and CLS from Performance Observer
        const evalRes = await sendCommand(target, "Runtime.evaluate", {
            expression: `(() => {
                const longTasks = performance.getEntriesByType ? performance.getEntriesByType('longtask').map(t => ({ durationMs: Math.round(t.duration), startTime: Math.round(t.startTime) })).slice(-5) : [];
                return { longTasksCount: longTasks.length, recentLongTasks: longTasks };
            })()`,
            returnByValue: true,
        }).catch(() => null);

        const webVitals = (evalRes?.result?.value as Record<string, unknown>) ?? { longTasksCount: 0, recentLongTasks: [] };

        const summary = {
            taskDurationMs,
            scriptDurationMs,
            layoutDurationMs,
            recalcStyleDurationMs,
            layoutCount,
            recalcStyleCount,
            longTasksCount: webVitals.longTasksCount,
        };

        const focus = opts.focus ?? "overview";
        if (focus === "overview") {
            const bottleneck =
                scriptDurationMs > layoutDurationMs * 2
                    ? "JavaScript execution (ScriptDuration dominant)"
                    : layoutDurationMs > scriptDurationMs
                    ? "Layout & Reflow (LayoutDuration dominant)"
                    : "Balanced / Normal";
            return {
                message: `[Process] Script: ${scriptDurationMs}ms | Layout: ${layoutDurationMs}ms (${layoutCount} reflows) | Style: ${recalcStyleDurationMs}ms (${recalcStyleCount} recalcs) | Bottleneck: ${bottleneck}`,
                ...summary,
            };
        }

        return {
            summary,
            focus,
            details: webVitals,
        };
    } catch (e) {
        return {
            error: `Failed to inspect process: ${errorMessage(e)}`,
        };
    }
}

// ============================================================================
// 3. HAR 1.2 Export & Network Analysis
// ============================================================================

export async function handleAnalyzeHar(
    target: chrome.debugger.Debuggee,
    opts: { filter?: string; includeBodies?: boolean } = {},
): Promise<Record<string, unknown>> {
    const rawRequests = listNetworkRequests({ filter: opts.filter, limit: 100 });
    if (rawRequests.length === 0) {
        return {
            message: "No network requests recorded in the buffer. Perform actions on the page or check if network collection is active.",
            totalRequests: 0,
            entries: [],
        };
    }

    let failedCount = 0;
    let totalSizeBytes = 0;
    let slowestDuration = 0;
    let slowestUrl = "";
    let apiCallsCount = 0;

    for (const r of rawRequests) {
        if (r.failed || (r.status && r.status >= 400)) failedCount++;
        totalSizeBytes += r.sizeBytes || 0;
        if ((r.durationMs || 0) > slowestDuration) {
            slowestDuration = r.durationMs || 0;
            slowestUrl = r.url || "";
        }
        if (r.resourceType === "XHR" || r.resourceType === "Fetch") apiCallsCount++;
    }

    const overview = {
        totalRequests: rawRequests.length,
        apiCallsCount,
        failedCount,
        totalSizeKb: Math.round(totalSizeBytes / 1024),
        slowestRequest: slowestUrl ? `${slowestUrl.slice(0, 80)} (${slowestDuration}ms)` : "none",
    };

    // Format into standard HAR 1.2 structure
    const harLog = {
        version: "1.2",
        creator: { name: "BrowserControl DevTools", version: "1.0" },
        pages: [
            {
                startedDateTime: new Date().toISOString(),
                id: "page_active",
                title: "BrowserControl Session",
                pageTimings: {},
            },
        ],
        entries: rawRequests.map((r) => ({
            startedDateTime: new Date(r.timestamp ?? Date.now()).toISOString(),
            time: r.durationMs ?? 0,
            request: {
                method: r.method ?? "GET",
                url: r.url ?? "",
                httpVersion: "HTTP/1.1",
                headers: Object.entries(r.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
                queryString: [],
                postData: r.postData ? { mimeType: "text/plain", text: r.postData } : undefined,
                headersSize: -1,
                bodySize: r.postData ? r.postData.length : 0,
            },
            response: {
                status: r.status ?? (r.failed ? 0 : 200),
                statusText: r.statusText ?? (r.failed ? r.errorText ?? "Failed" : "OK"),
                httpVersion: "HTTP/1.1",
                headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
                content: {
                    size: r.sizeBytes ?? 0,
                    mimeType: r.mimeType ?? "text/plain",
                },
                redirectURL: "",
                headersSize: -1,
                bodySize: r.sizeBytes ?? -1,
            },
            cache: {},
            timings: {
                send: 0,
                wait: r.durationMs ?? 0,
                receive: 0,
            },
        })),
    };

    return {
        overview,
        harLog,
    };
}

// ============================================================================
// 4. UI & Layout Deep Inspector (Box Model, Stacking Context, Computed CSS)
// ============================================================================

async function resolveNodeTarget(
    target: chrome.debugger.Debuggee,
    selector?: string,
    nodeId?: number,
): Promise<{ backendNodeId?: number; objectId?: string; error?: string }> {
    if (nodeId != null) {
        const resolveResult = await sendCommand(target, "DOM.resolveNode", {
            backendNodeId: nodeId,
        }).catch(() => null);
        return {
            backendNodeId: nodeId,
            objectId: resolveResult?.object?.objectId,
        };
    }
    if (selector) {
        const evalRes = await sendCommand(target, "Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(selector)})`,
        }).catch(() => null);
        const objectId = evalRes?.result?.objectId;
        if (!objectId) {
            return { error: `No element matches selector "${selector}"` };
        }
        const describeRes = await sendCommand(target, "DOM.describeNode", {
            objectId,
        }).catch(() => null);
        return {
            backendNodeId: describeRes?.node?.backendNodeId,
            objectId,
        };
    }
    return { error: "Missing selector or nodeId" };
}

export async function handleDebugLayout(
    target: chrome.debugger.Debuggee,
    opts: {
        selector?: string;
        nodeId?: number;
        focus?: "overview" | "box_model" | "computed" | "stacking";
    } = {},
): Promise<Record<string, unknown>> {
    try {
        const resolved = await resolveNodeTarget(target, opts.selector, opts.nodeId);
        if (resolved.error || !resolved.objectId) {
            return {
                error: resolved.error ?? "Failed to resolve element",
                hint: "Verify that the selector exists on the active page, or pass a valid nodeId from snapshot.",
            };
        }

        const { objectId, backendNodeId } = resolved;
        const boxModel = backendNodeId ? await sendCommand(target, "DOM.getBoxModel", { backendNodeId }).catch(() => null) : null;

        // Evaluate layout properties in page context
        const evalRes = await sendCommand(target, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function() {
                const el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
                if (!el || !(el instanceof Element)) return { error: "Not an element" };
                const cs = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                
                // Stacking Context checks
                const isPositioned = cs.position !== 'static';
                const hasZIndex = isPositioned && cs.zIndex !== 'auto';
                const createsStackingContext = 
                    el === document.documentElement ||
                    hasZIndex ||
                    parseFloat(cs.opacity) < 1 ||
                    cs.transform !== 'none' ||
                    cs.filter !== 'none' ||
                    cs.isolation === 'isolate' ||
                    cs.clipPath !== 'none';

                const isVisible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';

                return {
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || undefined,
                    className: el.className ? String(el.className).slice(0, 60) : undefined,
                    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                    isVisible,
                    display: cs.display,
                    position: cs.position,
                    zIndex: cs.zIndex,
                    opacity: cs.opacity,
                    transform: cs.transform !== 'none' ? cs.transform : undefined,
                    overflow: cs.overflow,
                    boxSizing: cs.boxSizing,
                    createsStackingContext,
                    stackingReason: createsStackingContext ? (hasZIndex ? 'z-index: ' + cs.zIndex : cs.opacity < 1 ? 'opacity: ' + cs.opacity : cs.transform !== 'none' ? 'transform' : 'isolation/filter') : 'none',
                    margin: \`\${cs.marginTop} \${cs.marginRight} \${cs.marginBottom} \${cs.marginLeft}\`,
                    padding: \`\${cs.paddingTop} \${cs.paddingRight} \${cs.paddingBottom} \${cs.paddingLeft}\`,
                    border: \`\${cs.borderTopWidth} \${cs.borderStyle} \${cs.borderColor}\`,
                };
            }`,
            returnByValue: true,
        }).catch(() => null);

        void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(() => {});
        const layoutInfo = (evalRes?.result?.value as Record<string, unknown>) ?? {};

        const focus = opts.focus ?? "overview";
        if (focus === "overview") {
            return {
                element: `<${layoutInfo.tagName}${layoutInfo.id ? ` id="${layoutInfo.id}"` : ""}>`,
                bounds: layoutInfo.bounds,
                isVisible: layoutInfo.isVisible,
                position: `${layoutInfo.position} (z-index: ${layoutInfo.zIndex})`,
                createsStackingContext: layoutInfo.createsStackingContext ? `YES (${layoutInfo.stackingReason})` : "NO",
                boxModel: {
                    margin: layoutInfo.margin,
                    padding: layoutInfo.padding,
                    border: layoutInfo.border,
                },
            };
        }

        return {
            element: layoutInfo,
            rawBoxModel: boxModel?.model,
            focus,
        };
    } catch (e) {
        return {
            error: `Failed to debug layout: ${errorMessage(e)}`,
        };
    }
}

// ============================================================================
// 5. Emulation Sandbox (Device / Network / CPU)
// ============================================================================

export async function handleEmulate(
    target: chrome.debugger.Debuggee,
    opts: {
        device?: "iphone14" | "pixel7" | "ipad" | "desktop" | string;
        network?: "offline" | "slow_3g" | "fast_3g" | "none";
        cpuSlowdown?: number;
        touch?: boolean;
    } = {},
): Promise<Record<string, unknown>> {
    const applied: string[] = [];

    // Device / Viewport Emulation
    if (opts.device) {
        const d = opts.device.toLowerCase();
        let width = 1280;
        let height = 800;
        let dsf = 1;
        let mobile = false;
        let touch = opts.touch ?? false;

        if (d === "iphone14" || d === "iphone") {
            width = 390;
            height = 844;
            dsf = 3;
            mobile = true;
            touch = true;
        } else if (d === "pixel7" || d === "android") {
            width = 412;
            height = 915;
            dsf = 2.625;
            mobile = true;
            touch = true;
        } else if (d === "ipad" || d === "tablet") {
            width = 810;
            height = 1080;
            dsf = 2;
            mobile = true;
            touch = true;
        } else if (d === "desktop") {
            width = 1280;
            height = 800;
            dsf = 1;
            mobile = false;
            touch = false;
        }

        await sendCommand(target, "Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: dsf,
            mobile,
        }).catch(() => {});

        if (touch) {
            await sendCommand(target, "Emulation.setTouchEmulationEnabled", {
                enabled: true,
                maxTouchPoints: 5,
            }).catch(() => {});
        } else {
            await sendCommand(target, "Emulation.setTouchEmulationEnabled", {
                enabled: false,
            }).catch(() => {});
        }
        applied.push(`Device: ${opts.device} (${width}x${height}, scale: ${dsf}, touch: ${touch})`);
    }

    // Network Throttling Emulation
    if (opts.network) {
        const net = opts.network;
        if (net === "offline") {
            await sendCommand(target, "Network.emulateNetworkConditions", {
                offline: true,
                latency: 0,
                downloadThroughput: 0,
                uploadThroughput: 0,
            }).catch(() => {});
            applied.push("Network: Offline");
        } else if (net === "slow_3g") {
            await sendCommand(target, "Network.emulateNetworkConditions", {
                offline: false,
                latency: 400,
                downloadThroughput: (500 * 1024) / 8, // 500 kbps
                uploadThroughput: (500 * 1024) / 8,
            }).catch(() => {});
            applied.push("Network: Slow 3G (400ms RTT, 500kbps)");
        } else if (net === "fast_3g") {
            await sendCommand(target, "Network.emulateNetworkConditions", {
                offline: false,
                latency: 150,
                downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
                uploadThroughput: (750 * 1024) / 8,
            }).catch(() => {});
            applied.push("Network: Fast 3G (150ms RTT, 1.6Mbps)");
        } else if (net === "none") {
            await sendCommand(target, "Network.emulateNetworkConditions", {
                offline: false,
                latency: 0,
                downloadThroughput: -1,
                uploadThroughput: -1,
            }).catch(() => {});
            applied.push("Network: Normal (No throttling)");
        }
    }

    // CPU Throttling
    if (opts.cpuSlowdown !== undefined) {
        const rate = Math.max(1, Math.min(20, opts.cpuSlowdown));
        await sendCommand(target, "Emulation.setCPUThrottlingRate", { rate }).catch(() => {});
        applied.push(`CPU Throttling: ${rate}x slowdown`);
    }

    return {
        success: true,
        message: `Emulation configured: ${applied.join(" | ")}`,
        applied,
    };
}

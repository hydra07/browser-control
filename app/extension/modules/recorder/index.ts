import type { FlowStep } from "@browsercontrol/shared";
import { attachFlowTrackerInPage } from "./trackerScript.js";

/**
 * Auto-Flow Interaction Recorder.
 * Records real human browsing interactions (clicks, typing, keys) and synthesizes
 * optimized, resilient FlowStep sequences ready to be saved and automated.
 */
export class FlowInteractionRecorder {
    private recording: boolean;
    private steps: FlowStep[];
    private tabId: number | null;
    private domain: string | null;
    private startedAt: number;
    private tabUpdateListener: ((updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) | null;

    constructor() {
        this.recording = false;
        this.steps = [];
        this.tabId = null;
        this.domain = null;
        this.startedAt = 0;
        this.tabUpdateListener = null;
    }

    public isRecording(): boolean {
        return this.recording;
    }

    public getRecordingTabId(): number | null {
        return this.tabId;
    }

    public getRecordedSteps(): FlowStep[] {
        return [...this.steps];
    }

    public getStepCount(): number {
        return this.steps.length;
    }

    public async injectTracker(targetTabId: number): Promise<void> {
        try {
            if (chrome.scripting?.executeScript) {
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    func: attachFlowTrackerInPage,
                });
            }
        } catch (e) {
            console.error("[browsercontrol] Failed to inject flow tracker:", e);
        }
    }

    public async start(tabId: number, domain?: string): Promise<{ success: boolean; message: string }> {
        this.recording = true;
        this.steps = [];
        this.tabId = tabId;
        this.domain = domain ?? null;
        this.startedAt = Date.now();

        // Attach tracker immediately
        await this.injectTracker(tabId);

        // Keep tracker attached across in-tab navigations
        if (this.tabUpdateListener) {
            chrome.tabs.onUpdated.removeListener(this.tabUpdateListener);
        }
        this.tabUpdateListener = (updatedTabId, changeInfo) => {
            if (this.recording && updatedTabId === this.tabId && changeInfo.status === "complete") {
                void this.injectTracker(updatedTabId);
            }
        };
        chrome.tabs.onUpdated.addListener(this.tabUpdateListener);

        return {
            success: true,
            message: `Auto-Flow recording started on tab ${tabId}. Interact naturally in Chrome; steps will be captured.`,
        };
    }

    /** Appends and optimizes live user interaction steps. */
    public addStep(step: FlowStep): void {
        if (!this.recording) return;

        const last = this.steps[this.steps.length - 1];

        // Merge continuous typing events on the same element into a single 'type' step
        if (last && last.action === "type" && step.action === "type") {
            const sameSelector = last.selector && step.selector && last.selector === step.selector;
            const sameRoleName = last.role && step.role && last.role === step.role && last.name === step.name;
            if (sameSelector || sameRoleName) {
                last.text = step.text;
                return;
            }
        }

        this.steps.push(step);
    }

    public stop(): {
        steps: FlowStep[];
        domain: string;
        stepCount: number;
        durationMs: number;
    } {
        const durationMs = Date.now() - this.startedAt;
        const capturedSteps = [...this.steps];
        const capturedDomain = this.domain ?? "global";

        if (this.tabUpdateListener) {
            chrome.tabs.onUpdated.removeListener(this.tabUpdateListener);
            this.tabUpdateListener = null;
        }

        this.recording = false;
        this.steps = [];
        this.tabId = null;
        this.domain = null;

        return {
            steps: capturedSteps,
            domain: capturedDomain,
            stepCount: capturedSteps.length,
            durationMs,
        };
    }
}

export const flowRecorder = new FlowInteractionRecorder();

import type {
    AssertionEvent,
    EvidenceQueryMode,
    EvidenceRun,
    EvidenceTimelineEvent,
    FailureEvent,
    FlowTargetDescriptor,
} from "@browsercontrol/shared";
import { subscribeActionLifecycle } from "../actions/events.js";

const DEFAULT_MAX_EVENTS = 500;
const MAX_EVENT_TEXT = 400;
const STORAGE_KEY = "browsercontrol_evidence_timeline_v1";
const STORAGE_SCHEMA_VERSION = 1;
const MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_BYTES = 512 * 1024;

type TimelineEvent = EvidenceTimelineEvent;

interface PersistedEvidenceState {
    schemaVersion: 1;
    runId: string;
    sessionId?: string;
    savedAt: number;
    events: TimelineEvent[];
    counts: {
        actions: number;
        assertions: number;
        failures: number;
        artifacts: number;
    };
    primaryFailureRef?: string;
    droppedEvents: number;
}
type EvidenceEventListener = (event: AssertionEvent | FailureEvent) => void;

const evidenceEventListeners = new Set<EvidenceEventListener>();

/** Subscribes to assertion and failure events before they enter the bounded timeline. */
export function subscribeEvidenceEvents(listener: EvidenceEventListener): () => void {
    evidenceEventListeners.add(listener);
    return () => evidenceEventListeners.delete(listener);
}

/** Publishes a non-action evidence event to in-process consumers. */
export function emitEvidenceEvent(event: AssertionEvent | FailureEvent): void {
    for (const listener of evidenceEventListeners) {
        try {
            listener(event);
        } catch (error) {
            console.warn("[browsercontrol] evidence listener failed:", error);
        }
    }
}

/** Records a bounded assertion event without exposing the caller's event id policy. */
export function emitAssertionEvent(
    event: Omit<AssertionEvent, "type" | "id" | "timestamp"> & { timestamp?: number },
): void {
    emitEvidenceEvent({
        type: "assertion",
        id: `as${crypto.randomUUID()}`,
        timestamp: event.timestamp ?? Date.now(),
        expression: event.expression,
        result: event.result,
        sensitive: event.sensitive,
    });
}

/** Records a bounded failure event without allowing unbounded event text. */
export function emitFailureEvent(
    event: Omit<FailureEvent, "type" | "id" | "timestamp"> & { timestamp?: number },
): void {
    emitEvidenceEvent({
        type: "failure",
        id: `f${crypto.randomUUID()}`,
        timestamp: event.timestamp ?? Date.now(),
        phase: event.phase,
        code: event.code,
        message: event.message,
    });
}

function boundedText(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > MAX_EVENT_TEXT ? `${normalized.slice(0, MAX_EVENT_TEXT - 1)}…` : normalized;
}

function optionalBoundedText(value: unknown): string | undefined {
    return typeof value === "string" ? boundedText(value) : undefined;
}

function normalizeTarget(target: FlowTargetDescriptor): FlowTargetDescriptor {
    const source = target as Record<string, unknown>;
    const ancestors = Array.isArray(source.ancestors)
        ? (source.ancestors as unknown[])
              .slice(0, 3)
              .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
              .map((item) => ({
                  ...(optionalBoundedText(item.role) ? { role: optionalBoundedText(item.role) } : {}),
                  ...(optionalBoundedText(item.name) ? { name: optionalBoundedText(item.name) } : {}),
              }))
        : undefined;
    const nearby = Array.isArray(source.nearby)
        ? (source.nearby as unknown[])
              .slice(0, 4)
              .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
              .map((item) => ({
                  relation: (item.relation === "before" ||
                  item.relation === "after" ||
                  item.relation === "inside" ||
                  item.relation === "label"
                      ? item.relation
                      : "inside") as "before" | "after" | "inside" | "label",
                  ...(optionalBoundedText(item.role) ? { role: optionalBoundedText(item.role) } : {}),
                  ...(optionalBoundedText(item.name) ? { name: optionalBoundedText(item.name) } : {}),
              }))
        : undefined;
    const selectorHints = Array.isArray(source.selectorHints)
        ? (source.selectorHints as unknown[])
              .filter((item): item is string => typeof item === "string")
              .slice(0, 3)
              .map(boundedText)
        : undefined;
    return {
        ...(optionalBoundedText(source.role) ? { role: optionalBoundedText(source.role) } : {}),
        ...(optionalBoundedText(source.name) ? { name: optionalBoundedText(source.name) } : {}),
        ...(optionalBoundedText(source.testId) ? { testId: optionalBoundedText(source.testId) } : {}),
        ...(optionalBoundedText(source.id) ? { id: optionalBoundedText(source.id) } : {}),
        ...(optionalBoundedText(source.href) ? { href: optionalBoundedText(source.href) } : {}),
        ...(optionalBoundedText(source.inputType) ? { inputType: optionalBoundedText(source.inputType) } : {}),
        ...(optionalBoundedText(source.inputName) ? { inputName: optionalBoundedText(source.inputName) } : {}),
        ...(ancestors && ancestors.length > 0 ? { ancestors } : {}),
        ...(nearby && nearby.length > 0 ? { nearby } : {}),
        ...(selectorHints && selectorHints.length > 0 ? { selectorHints } : {}),
    };
}

function normalizeEvent(event: TimelineEvent): TimelineEvent {
    if (event.type === "assertion") {
        return {
            ...event,
            expression: event.sensitive ? "Sensitive assertion" : boundedText(event.expression),
        };
    }
    if (event.type === "failure") {
        return { ...event, code: boundedText(event.code), message: boundedText(event.message) };
    }
    if (event.type === "action_started") {
        if (event.sensitive) {
            return { ...event, targetRef: undefined, semanticTarget: undefined, bounds: undefined };
        }
        return {
            ...event,
            ...(event.semanticTarget ? { semanticTarget: normalizeTarget(event.semanticTarget) } : {}),
        };
    }
    if (event.type === "action_finished" && event.sensitive) {
        return { ...event, targetRef: undefined };
    }
    return event;
}

function nonNegativeCount(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const event = value as Record<string, unknown>;
    if (event.type === "action_started") return typeof event.actionId === "string" && typeof event.action === "string";
    if (event.type === "action_finished") return typeof event.actionId === "string" && typeof event.action === "string";
    if (event.type === "assertion") return typeof event.id === "string" && typeof event.expression === "string";
    if (event.type === "failure") return typeof event.id === "string" && typeof event.message === "string";
    return false;
}

/** Bounded in-memory event track whose overview never exposes the event array. */
export class EvidenceTimelineStore {
    private readonly maxEvents: number;
    private runId: string;
    private sessionId: string | undefined;
    private readonly events: TimelineEvent[];
    private actionCount: number;
    private assertionCount: number;
    private failureCount: number;
    private artifactCount: number;
    private primaryFailureRef: string | undefined;
    private droppedEvents: number;

    constructor(maxEvents = DEFAULT_MAX_EVENTS) {
        this.maxEvents = Math.max(1, Math.floor(maxEvents));
        this.runId = `ev${crypto.randomUUID()}`;
        this.sessionId = undefined;
        this.events = [];
        this.actionCount = 0;
        this.assertionCount = 0;
        this.failureCount = 0;
        this.artifactCount = 0;
        this.primaryFailureRef = undefined;
        this.droppedEvents = 0;
    }

    public append(event: TimelineEvent): void {
        const normalized = normalizeEvent(event);
        if (normalized.type === "action_finished") this.actionCount++;
        if (normalized.type === "assertion") this.assertionCount++;
        if (normalized.type === "failure") {
            this.failureCount++;
            this.primaryFailureRef ??= normalized.id;
        }
        if (this.events.length >= this.maxEvents) {
            this.events.shift();
            this.droppedEvents++;
        }
        this.events.push(normalized);
    }

    public addArtifact(): void {
        this.artifactCount++;
    }

    public activateSession(sessionId: string): void {
        if (!sessionId || this.sessionId === sessionId) return;
        this.clear();
        this.sessionId = sessionId;
    }

    public primaryFailure(): FailureEvent | undefined {
        if (!this.primaryFailureRef) return undefined;
        const event = this.events.find(
            (candidate): candidate is FailureEvent =>
                candidate.type === "failure" && candidate.id === this.primaryFailureRef,
        );
        return event ? { ...event } : undefined;
    }

    public serialize(): PersistedEvidenceState {
        return {
            schemaVersion: STORAGE_SCHEMA_VERSION,
            runId: this.runId,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            savedAt: Date.now(),
            events: this.events.map((event) => ({ ...event })),
            counts: {
                actions: this.actionCount,
                assertions: this.assertionCount,
                failures: this.failureCount,
                artifacts: this.artifactCount,
            },
            ...(this.primaryFailureRef ? { primaryFailureRef: this.primaryFailureRef } : {}),
            droppedEvents: this.droppedEvents,
        };
    }

    public hydrate(value: unknown): boolean {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const state = value as Partial<PersistedEvidenceState>;
        if (
            state.schemaVersion !== STORAGE_SCHEMA_VERSION ||
            typeof state.runId !== "string" ||
            !Array.isArray(state.events) ||
            typeof state.savedAt !== "number"
        )
            return false;
        const events = state.events.filter(isTimelineEvent).map(normalizeEvent).slice(-this.maxEvents);
        this.events.length = 0;
        this.events.push(...events);
        this.runId = state.runId;
        this.sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
        this.actionCount = nonNegativeCount(
            state.counts?.actions,
            events.filter((event) => event.type === "action_finished").length,
        );
        this.assertionCount = nonNegativeCount(
            state.counts?.assertions,
            events.filter((event) => event.type === "assertion").length,
        );
        this.failureCount = nonNegativeCount(
            state.counts?.failures,
            events.filter((event) => event.type === "failure").length,
        );
        this.artifactCount = nonNegativeCount(state.counts?.artifacts, 0);
        this.primaryFailureRef = typeof state.primaryFailureRef === "string" ? state.primaryFailureRef : undefined;
        this.droppedEvents = nonNegativeCount(state.droppedEvents, 0);
        return true;
    }

    public overview(sessionId: string, profile: EvidenceRun["profile"]): EvidenceRun & { droppedEvents: number } {
        return {
            schemaVersion: 1,
            id: this.runId,
            sessionId,
            profile,
            counts: {
                actions: this.actionCount,
                assertions: this.assertionCount,
                failures: this.failureCount,
                artifacts: this.artifactCount,
            },
            timelineRef: `${this.runId}:timeline`,
            ...(this.primaryFailureRef ? { primaryFailureRef: this.primaryFailureRef } : {}),
            droppedEvents: this.droppedEvents,
        };
    }

    public eventsAfter(after = 0, limit = 20): TimelineEvent[] {
        const start = Math.max(0, Math.floor(after));
        const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), this.maxEvents);
        return this.events.slice(start, start + boundedLimit).map((event) => ({ ...event }));
    }

    public retainedEventCount(): number {
        return this.events.length;
    }

    public clear(): void {
        this.events.length = 0;
        this.actionCount = 0;
        this.assertionCount = 0;
        this.failureCount = 0;
        this.artifactCount = 0;
        this.primaryFailureRef = undefined;
        this.droppedEvents = 0;
    }
}

/** Connects action, assertion, and failure streams to the bounded evidence timeline. */
export function installActionLifecycleEvidence(store = evidenceTimeline, onChanged?: () => void): () => void {
    const append = (event: TimelineEvent): void => {
        store.append(event);
        onChanged?.();
    };
    const disposeActions = subscribeActionLifecycle(append);
    const disposeEvidence = subscribeEvidenceEvents(append);
    return () => {
        disposeActions();
        disposeEvidence();
    };
}

export function setEvidenceSession(sessionId: string): void {
    evidenceTimeline.activateSession(sessionId);
}

export function queryEvidence(
    sessionId: string,
    mode: EvidenceQueryMode = "overview",
    after = 0,
    limit = 20,
    profile: EvidenceRun["profile"] = "flow",
): Record<string, unknown> {
    evidenceTimeline.activateSession(sessionId);
    const overview = evidenceTimeline.overview(sessionId, profile);
    if (mode === "overview") return { overview };
    if (mode === "failure") return { overview, failure: evidenceTimeline.primaryFailure() ?? null };
    const max = mode === "export" ? evidenceTimeline.retainedEventCount() : Math.min(limit, 100);
    const events = evidenceTimeline.eventsAfter(mode === "export" ? 0 : after, max);
    return {
        overview,
        events,
        ...(mode === "events"
            ? {
                  nextAfter: Math.max(0, Math.floor(after)) + events.length,
                  hasMore: Math.max(0, Math.floor(after)) + events.length < evidenceTimeline.retainedEventCount(),
              }
            : {}),
    };
}

let persistChain = Promise.resolve();

function getSessionStorage(): chrome.storage.StorageArea | undefined {
    if (typeof chrome === "undefined") return undefined;
    return chrome.storage?.session;
}

/** Restores the bounded evidence track across service-worker suspension. */
export async function restoreEvidenceTimeline(store = evidenceTimeline): Promise<void> {
    const storage = getSessionStorage();
    if (!storage) return;
    try {
        const stored = await storage.get(STORAGE_KEY);
        const candidate = stored[STORAGE_KEY];
        if (
            candidate &&
            typeof candidate === "object" &&
            "savedAt" in candidate &&
            typeof candidate.savedAt === "number" &&
            Date.now() - candidate.savedAt <= MAX_PERSISTED_AGE_MS
        ) {
            if (store.hydrate(candidate)) return;
        }
        await storage.remove(STORAGE_KEY);
    } catch (error) {
        console.warn("[browsercontrol] evidence timeline restore failed:", error);
    }
}

/** Persists only the bounded, redacted event track; large history is trimmed before storage. */
export function persistEvidenceTimeline(store = evidenceTimeline): void {
    const storage = getSessionStorage();
    if (!storage) return;
    let value = store.serialize();
    while (JSON.stringify(value).length > MAX_PERSISTED_BYTES && value.events.length > 1) {
        value = { ...value, events: value.events.slice(-Math.max(1, Math.floor(value.events.length / 2))) };
    }
    if (JSON.stringify(value).length > MAX_PERSISTED_BYTES) {
        value = { ...value, events: [] };
    }
    persistChain = persistChain
        .then(() => storage.set({ [STORAGE_KEY]: value }))
        .catch((error: unknown) => {
            console.warn("[browsercontrol] evidence timeline persistence failed:", error);
        });
}

export const evidenceTimeline = new EvidenceTimelineStore();

import type { ActionLifecycleEvent } from "@browsercontrol/shared";

export type ActionLifecycleListener = (event: ActionLifecycleEvent) => void;

const listeners = new Set<ActionLifecycleListener>();

/** Subscribes to immutable action lifecycle events and returns its disposer. */
export function subscribeActionLifecycle(listener: ActionLifecycleListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Publishes an action lifecycle event to in-process overlay/evidence consumers. */
export function emitActionLifecycle(event: ActionLifecycleEvent): void {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch (error) {
            console.warn("[browsercontrol] action lifecycle listener failed:", error);
        }
    }
}

/** Serializes browser work because active-tab and evidence state are shared. */
export class CommandQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private readonly pending = new Map<string, AbortController>();

    public cancel(id?: string): void {
        if (id) this.pending.get(id)?.abort();
        else for (const controller of this.pending.values()) controller.abort();
    }

    public run<T>(id: string, deadline: number | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.pending.has(id)) return Promise.reject(new Error("Duplicate request id"));
        if (this.pending.size >= 64) return Promise.reject(new Error("Browser command queue is full"));
        const controller = new AbortController();
        this.pending.set(id, controller);
        const result = this.tail.then(async () => {
            if (controller.signal.aborted || (deadline !== undefined && Date.now() >= deadline)) {
                throw new Error("Request cancelled or expired before execution; no action was dispatched");
            }
            return task(controller.signal);
        });
        this.tail = result.catch(() => {});
        return result.finally(() => this.pending.delete(id));
    }
}

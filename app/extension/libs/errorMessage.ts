/** `e instanceof Error ? e.message : String(e)` — every catch block across every module needs this, so it lives here once instead of re-inlined per module. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

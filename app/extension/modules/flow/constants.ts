export const MAX_FLOW_STEPS = 20;
export const WAIT_FOR_POLL_MS = 250;
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 3000;
// Was inlined as a bare 3500 at the call site — too tight for a step whose
// target only appears after the previous step's own navigation/animation
// finishes (an accordion reveal, a search-results render). Steps needing a
// different budget still override via step.timeoutMs.
export const DEFAULT_STEP_TIMEOUT_MS = 5000;
// A full page snapshot after every step cost 87k+ tokens in one real
// 10-call explore_flow session (77% of that session's total tool-call
// spend) — mostly the SAME static content re-emitted every step. A diff
// against the previous step is both smaller and more directly useful.
export const MAX_DELTA_ENTRIES = 30;

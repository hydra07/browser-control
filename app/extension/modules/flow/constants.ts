export const MAX_FLOW_STEPS = 20;
export const WAIT_FOR_POLL_MS = 250;
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 3000;
// A full page snapshot after every step cost 87k+ tokens in one real
// 10-call explore_flow session (77% of that session's total tool-call
// spend) — mostly the SAME static content re-emitted every step. A diff
// against the previous step is both smaller and more directly useful.
export const MAX_DELTA_ENTRIES = 30;

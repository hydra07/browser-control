export const MAX_JOB_TASKS = 20;
export const MAX_CONCURRENT_JOBS = 3;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;

/**
 * Bounds one task (navigate + extract on one page), not the whole job — a
 * task that blows through it is likely a hung page load; the worker should
 * move on rather than stall the job behind one stuck tab.
 */
export const TASK_TIMEOUT_MS = 45000;

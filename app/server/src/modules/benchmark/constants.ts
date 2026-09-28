export const DEFAULT_BENCHMARK_URL = "https://httpbin.org/forms/post";
export const DEFAULT_BENCHMARK_RUNS = 1;
export const MAX_BENCHMARK_RUNS = 10;
export const BENCHMARK_TASK_COUNT = 5;
export const BENCHMARK_TIMEOUT_MS = 120_000;
export const BENCHMARK_MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
export const TOKEN_ESTIMATE_METHOD = "heuristic_chars_div_4" as const;

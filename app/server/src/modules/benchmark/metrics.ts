import { TOKEN_ESTIMATE_METHOD } from "./constants.js";
import type { BenchmarkTaskResult, CommandMeasurement, RuntimeBenchmarkReport, TokenCost } from "./types.js";

/** Estimates provider-independent tokens while labeling the heuristic explicitly. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4));
}

export function measureTokenCost(text: string): TokenCost {
  return {
    chars: text.length,
    estimatedTokens: estimateTokens(text.length),
    method: TOKEN_ESTIMATE_METHOD,
  };
}

/** Aggregates one repeatable task without retaining its raw browser response. */
export function summarizeTask(
  name: string,
  run: number,
  measurements: readonly CommandMeasurement[],
  expectedRecoveryCalls: number,
  error?: string,
): BenchmarkTaskResult {
  const inputChars = measurements.reduce((total, measurement) => total + measurement.inputChars, 0);
  const outputChars = measurements.reduce((total, measurement) => total + measurement.outputChars, 0);
  const inputTokens = estimateTokens(inputChars);
  const outputTokens = estimateTokens(outputChars);

  return {
    name,
    run,
    success: error === undefined,
    roundtrips: measurements.length,
    inputChars,
    outputChars,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs: measurements.reduce((total, measurement) => total + measurement.durationMs, 0),
    expectedRecoveryCalls,
    ...(error ? { error } : {}),
  };
}

/** Builds the stable JSON report consumed by CI or a later before/after comparison. */
export function buildReport(
  config: RuntimeBenchmarkReport["config"],
  fixedCost: RuntimeBenchmarkReport["fixedCost"],
  tasks: readonly BenchmarkTaskResult[],
): RuntimeBenchmarkReport {
  const successfulTaskRuns = tasks.filter((task) => task.success).length;
  const summary = tasks.reduce(
    (total, task) => ({
      taskRuns: total.taskRuns + 1,
      successfulTaskRuns: total.successfulTaskRuns + (task.success ? 1 : 0),
      totalRoundtrips: total.totalRoundtrips + task.roundtrips,
      totalInputChars: total.totalInputChars + task.inputChars,
      totalOutputChars: total.totalOutputChars + task.outputChars,
      totalInputTokens: total.totalInputTokens + task.inputTokens,
      totalOutputTokens: total.totalOutputTokens + task.outputTokens,
      totalTokens: total.totalTokens + task.totalTokens,
      totalDurationMs: total.totalDurationMs + task.durationMs,
      averageDurationMs: 0,
      recoveryCalls: total.recoveryCalls + task.expectedRecoveryCalls,
    }),
    {
      taskRuns: 0,
      successfulTaskRuns: 0,
      totalRoundtrips: 0,
      totalInputChars: 0,
      totalOutputChars: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      recoveryCalls: 0,
    },
  );
  summary.successfulTaskRuns = successfulTaskRuns;
  summary.averageDurationMs = tasks.length > 0 ? Math.round(summary.totalDurationMs / tasks.length) : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      transport: "authenticated_execute_http",
      tokenEstimator: TOKEN_ESTIMATE_METHOD,
      excludesMcpSchemaAndInstructionCost: true,
    },
    config,
    fixedCost,
    tasks: [...tasks],
    summary,
  };
}

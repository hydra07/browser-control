import { describe, expect, test } from "bun:test";
import { buildReport, measureTokenCost, summarizeTask } from "./metrics.js";
import type { CommandMeasurement } from "./types.js";

function measurement(overrides: Partial<CommandMeasurement> = {}): CommandMeasurement {
  return {
    cmd: "snapshot",
    inputChars: 40,
    outputChars: 80,
    durationMs: 100,
    ok: true,
    ...overrides,
  };
}

describe("runtime benchmark metrics", () => {
  test("summarizes command measurements without retaining responses", () => {
    const task = summarizeTask(
      "semantic_snapshot",
      1,
      [measurement(), measurement({ cmd: "snapshot", inputChars: 60, outputChars: 120, durationMs: 200 })],
      0,
    );

    expect(task).toEqual({
      name: "semantic_snapshot",
      run: 1,
      success: true,
      roundtrips: 2,
      inputChars: 100,
      outputChars: 200,
      inputTokens: 25,
      outputTokens: 50,
      totalTokens: 75,
      durationMs: 300,
      expectedRecoveryCalls: 0,
    });
  });

  test("aggregates task runs and reports the estimator methodology", () => {
    const task = summarizeTask("network_observation", 1, [measurement({ outputChars: 40 })], 0);
    const report = buildReport(
      {
        daemonOrigin: "http://127.0.0.1:8765",
        pageOrigin: "https://httpbin.org",
        runs: 1,
        capabilityProfile: "unconfigured",
      },
      {
        toolSchemas: measureTokenCost("schema"),
        instructions: measureTokenCost("instructions"),
      },
      [task],
    );

    expect(report.methodology).toEqual({
      transport: "authenticated_execute_http",
      tokenEstimator: "heuristic_chars_div_4",
      excludesMcpSchemaAndInstructionCost: true,
    });
    expect(report.summary).toMatchObject({
      taskRuns: 1,
      successfulTaskRuns: 1,
      totalRoundtrips: 1,
      totalInputChars: 40,
      totalOutputChars: 40,
      totalTokens: 20,
      totalDurationMs: 100,
      averageDurationMs: 100,
    });
  });
});

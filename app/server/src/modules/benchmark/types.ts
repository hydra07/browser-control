export interface CommandMeasurement {
  cmd: string;
  inputChars: number;
  outputChars: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface CommandExecution {
  result: unknown;
  measurement: CommandMeasurement;
}

export interface BenchmarkTaskResult {
  name: string;
  run: number;
  success: boolean;
  roundtrips: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  expectedRecoveryCalls: number;
  error?: string;
}

export interface TokenCost {
  chars: number;
  estimatedTokens: number;
  method: "heuristic_chars_div_4";
}

export interface RuntimeBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  methodology: {
    transport: "authenticated_execute_http";
    tokenEstimator: "heuristic_chars_div_4";
    excludesMcpSchemaAndInstructionCost: true;
  };
  config: {
    daemonOrigin: string;
    pageOrigin: string;
    runs: number;
    capabilityProfile: string;
  };
  fixedCost: {
    toolSchemas: TokenCost;
    instructions: TokenCost;
  };
  tasks: BenchmarkTaskResult[];
  summary: {
    taskRuns: number;
    successfulTaskRuns: number;
    totalRoundtrips: number;
    totalInputChars: number;
    totalOutputChars: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalDurationMs: number;
    averageDurationMs: number;
    recoveryCalls: number;
  };
}

export type JsonRecord = Record<string, unknown>;

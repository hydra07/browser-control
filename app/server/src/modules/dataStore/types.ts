import type { FlowStep } from "@browsercontrol/shared";

export interface RecordArtifactInput {
  sessionId: string;
  kind: "log" | "image" | "video";
  path: string;
  source?: string;
  /**
   * Omit for 'log' — that file is appended to for the whole session, so a
   * cached size would go stale immediately; callers stat it live instead
   * (see dataCli.ts). image/video are write-once, so the caller passes
   * the real size at insert time.
   */
  sizeBytes?: number;
  createdAt?: number;
}

export interface DocsBlockMeta {
  id: number;
  sessionId: string;
  source: string;
  title: string | null;
  charCount: number;
  createdAt: number;
}

export interface DocsBlockRow {
  id: number;
  session_id: string;
  source: string;
  title: string | null;
  char_count: number;
  created_at: number;
}

export interface DocsBlockResult {
  blockId: number;
  charCount: number;
  sessionTotalChars: number;
}

export interface DocsBlockFull extends DocsBlockMeta {
  content: string;
}

export interface DocsSearchResult {
  id: number;
  sessionId: string;
  source: string;
  title: string | null;
  snippet: string;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  startedAt: number;
  endedAt: number | null;
  toolCalls: number;
  images: number;
  videos: number;
  docsBlocks: number;
  docsChars: number;
}

export interface ArtifactRow {
  id: number;
  kind: string;
  path: string;
  source: string | null;
  sizeBytes: number | null;
  createdAt: number;
}

export interface SessionDetail extends SessionSummary {
  hosts: string[];
  artifacts: ArtifactRow[];
  docBlockList: DocsBlockMeta[];
}

export interface DeleteSummary {
  deletedSessions: number;
  deletedFiles: number;
  freedBytes: number;
  errors: string[];
}

export interface FlowMeta {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  stepCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlowFull extends FlowMeta {
  steps: FlowStep[];
}

export interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  steps_json: string;
  created_at: number;
  updated_at: number;
}

export interface ToolCallRecordInput {
  sessionId: string;
  cmd: string;
  args: Record<string, unknown>;
  durationMs: number;
  inChars?: number;
  inTokens?: number;
  outChars?: number;
  outTokens?: number;
  approxChars: number;
  approxTokens: number;
  hasImage: boolean;
  isError: boolean;
  source: string;
  preview: string;
  elementRole?: string;
  elementName?: string;
  stepCount?: number;
  createdAt?: number;
}

export interface BenchmarkMetrics {
  summary: {
    sessionId: string;
    sessionName: string;
    startedAt: number;
    totalCalls: number;
    totalInTokens: number;
    totalOutTokens: number;
    totalTokens: number;
    totalInChars: number;
    totalOutChars: number;
    avgInTokensPerCall: number;
    avgOutTokensPerCall: number;
    avgTokensPerCall: number;
    avgDurationMs: number;
    totalDurationMs: number;
    errorCount: number;
    errorRatePct: number;
    flowStepTotal: number;
  };
  tokenSavings: {
    estimatedSavedTokens: number;
    savingsBreakdown: {
      fromFlowBatching: number;
      fromCompactSnapshots: number;
      fromDocsBlocks: number;
    };
  };
  byCommand: Array<{
    cmd: string;
    count: number;
    inTokens: number;
    outTokens: number;
    totalTokens: number;
    avgTokens: number;
    totalDurationMs: number;
    avgDurationMs: number;
    errorCount: number;
    pctOfTokens: number;
  }>;
  recentCalls: Array<{
    id: number;
    cmd: string;
    durationMs: number;
    inTokens: number;
    outTokens: number;
    approxTokens: number;
    isError: boolean;
    source: string;
    preview: string;
    elementRole?: string;
    elementName?: string;
    stepCount?: number;
    createdAt: number;
    argsSummary: string;
  }>;
}

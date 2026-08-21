import type { ToolArgs } from "../../libs/types.js";

export interface CallLogEntry {
  ts: string;
  cmd: string;
  args: ToolArgs;
  durationMs: number;
  inChars: number;
  inTokens: number;
  outChars: number;
  outTokens: number;
  approxChars: number;
  approxTokens: number;
  hasImage: boolean;
  isError: boolean;
  source: string;
  preview: string;
  elementRole?: string;
  elementName?: string;
}

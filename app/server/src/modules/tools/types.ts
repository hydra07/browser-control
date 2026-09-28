import type { ArtifactRef, EvidenceRun, EvidenceTimelineEvent } from "@browsercontrol/shared";
import type { Executor } from "../../libs/types.js";
import type { CapabilityProfile } from "./capabilities.js";

/** What handleToolCall needs from daemon.ts, passed in rather than imported — same reasoning as jobs/crawl's Executor param: this module shouldn't have to import daemon.ts (which imports this one). */
export interface StoredArtifact {
  ref: ArtifactRef;
  path: string;
}

export interface ToolHandlerCtx {
  executeCommand: Executor;
  sessionId: string;
  inlineImages: boolean;
  saveScreenshotToFile: (dataBase64: string, format: string) => StoredArtifact;
  saveVideoToFile: (dataBase64: string, format: string) => StoredArtifact;
  saveEvidenceTrack: (input: { overview: EvidenceRun; events: EvidenceTimelineEvent[] }) => StoredArtifact;
  capabilityProfile?: CapabilityProfile;
}

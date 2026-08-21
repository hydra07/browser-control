import type { Executor } from "../../libs/types.js";

/** What handleToolCall needs from daemon.ts, passed in rather than imported — same reasoning as jobs/crawl's Executor param: this module shouldn't have to import daemon.ts (which imports this one). */
export interface ToolHandlerCtx {
  executeCommand: Executor;
  sessionId: string;
  inlineImages: boolean;
  saveScreenshotToFile: (dataBase64: string, format: string) => string;
  saveVideoToFile: (dataBase64: string, format: string) => string;
}

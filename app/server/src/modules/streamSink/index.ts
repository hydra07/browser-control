import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { VIDEOS_DIR } from "../../configs/paths.js";
import * as dataStore from "../dataStore/index.js";

interface ActiveStream {
  streamId: string;
  sessionId: string;
  filePath: string;
  format: string;
  writeStream: WriteStream;
  startedAt: number;
  totalBytesWritten: number;
  chunkCount: number;
  writeQueue: Promise<void>;
  writeError: string | null;
  hasWebmHeader: boolean | null;
}

let currentStream: ActiveStream | null = null;

/**
 * Initializes a real-time disk-append stream sink for screen recording video.
 * Chunks are written incrementally to disk with O(1) memory overhead.
 */
export function startRecordingStream(sessionId: string, format = "webm"): { streamId: string; filePath: string } {
  if (currentStream) {
    throw new Error("A recording stream is already active");
  }

  const streamId = crypto.randomUUID();
  const filePath = join(VIDEOS_DIR, `recording-${Date.now()}.${format}`);
  const writeStream = createWriteStream(filePath, { flags: "w" });

  currentStream = {
    streamId,
    sessionId,
    filePath,
    format,
    writeStream,
    startedAt: Date.now(),
    totalBytesWritten: 0,
    chunkCount: 0,
    writeQueue: Promise.resolve(),
    writeError: null,
    hasWebmHeader: null,
  };

  return { streamId, filePath };
}

/**
 * Appends a raw binary chunk from the WebSocket Opcode 0x02 stream directly to the video file.
 */
export function appendVideoChunk(payload: Uint8Array): void {
  const activeStream = currentStream;
  if (!activeStream) return;

  const chunk = Buffer.from(payload);
  if (!activeStream.hasWebmHeader) {
    for (let i = 0; i <= chunk.byteLength - 4; i++) {
      if (chunk[i] === 0x1a && chunk[i + 1] === 0x45 && chunk[i + 2] === 0xdf && chunk[i + 3] === 0xa3) {
        activeStream.hasWebmHeader = true;
        break;
      }
    }
  }
  activeStream.writeQueue = activeStream.writeQueue
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve, reject) => {
          activeStream.writeStream.write(chunk, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    )
    .then(
      () => {
        activeStream.totalBytesWritten += chunk.byteLength;
        activeStream.chunkCount++;
      },
      (error: unknown) => {
        activeStream.writeError ??= error instanceof Error ? error.message : String(error);
      },
    );
}

/**
 * Closes the active stream sink immediately without post-processing re-encoding delay.
 */
export async function stopRecordingStream(options: { commit?: boolean } = {}): Promise<{
  success: boolean;
  filePath: string;
  durationMs: number;
  sizeBytes: number;
  chunkCount: number;
  error?: string;
} | null> {
  if (!currentStream) return null;

  const activeStream = currentStream;
  const { sessionId, filePath, writeStream, startedAt } = activeStream;
  const durationMs = Date.now() - startedAt;
  currentStream = null;

  await activeStream.writeQueue;
  await new Promise<void>((resolve, reject) => {
    writeStream.once("error", reject);
    writeStream.end(() => resolve());
  }).catch((error: unknown) => {
    activeStream.writeError ??= error instanceof Error ? error.message : String(error);
  });

  if (activeStream.totalBytesWritten === 0) {
    activeStream.writeError ??= "Recorder produced an empty WebM stream";
  } else if (activeStream.hasWebmHeader !== true) {
    activeStream.writeError ??= "Recorder output is missing the WebM EBML header";
  }
  if (options.commit === false) {
    activeStream.writeError ??= "Capture did not complete successfully";
  }
  const success = activeStream.writeError === null;

  if (success) {
    dataStore.recordArtifact({
      sessionId,
      kind: "video",
      path: filePath,
      source: "recording",
      sizeBytes: activeStream.totalBytesWritten,
    });
  } else {
    await rm(filePath, { force: true });
  }

  return {
    success,
    filePath,
    durationMs,
    sizeBytes: activeStream.totalBytesWritten,
    chunkCount: activeStream.chunkCount,
    ...(activeStream.writeError ? { error: activeStream.writeError } : {}),
  };
}

/** Closes and removes the exact in-flight file when capture startup fails before a valid recording exists. */
export async function abortRecordingStream(): Promise<void> {
  if (!currentStream) return;
  const activeStream = currentStream;
  currentStream = null;
  await activeStream.writeQueue;
  await new Promise<void>((resolve) => activeStream.writeStream.end(resolve));
  await rm(activeStream.filePath, { force: true });
}

export function isRecordingActive(): boolean {
  return currentStream !== null;
}

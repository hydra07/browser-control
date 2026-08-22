import { createWriteStream, type WriteStream } from "node:fs";
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
}

let currentStream: ActiveStream | null = null;

/**
 * Initializes a real-time disk-append stream sink for screen recording video.
 * Chunks are written incrementally to disk with O(1) memory overhead.
 */
export function startRecordingStream(sessionId: string, format = "webm"): { streamId: string; filePath: string } {
  if (currentStream) {
    stopRecordingStream();
  }

  const streamId = crypto.randomUUID();
  const filePath = join(VIDEOS_DIR, `recording-${Date.now()}.${format}`);
  const writeStream = createWriteStream(filePath, { flags: "a" });

  currentStream = {
    streamId,
    sessionId,
    filePath,
    format,
    writeStream,
    startedAt: Date.now(),
    totalBytesWritten: 0,
    chunkCount: 0,
  };

  return { streamId, filePath };
}

/**
 * Appends a raw binary chunk from the WebSocket Opcode 0x02 stream directly to the video file.
 */
export function appendVideoChunk(payload: Uint8Array): void {
  if (!currentStream) return;

  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  currentStream.writeStream.write(buf);
  currentStream.totalBytesWritten += payload.byteLength;
  currentStream.chunkCount++;
}

/**
 * Closes the active stream sink immediately without post-processing re-encoding delay.
 */
export function stopRecordingStream(): {
  success: boolean;
  filePath: string;
  durationMs: number;
  sizeBytes: number;
  chunkCount: number;
} | null {
  if (!currentStream) return null;

  const { sessionId, filePath, writeStream, startedAt, totalBytesWritten, chunkCount } = currentStream;
  const durationMs = Date.now() - startedAt;

  writeStream.end();
  currentStream = null;

  dataStore.recordArtifact({
    sessionId,
    kind: "video",
    path: filePath,
    source: "recording",
    sizeBytes: totalBytesWritten,
  });

  return {
    success: true,
    filePath,
    durationMs,
    sizeBytes: totalBytesWritten,
    chunkCount,
  };
}

export function isRecordingActive(): boolean {
  return currentStream !== null;
}

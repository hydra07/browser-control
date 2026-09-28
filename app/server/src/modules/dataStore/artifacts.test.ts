import { describe, expect, test } from "bun:test";
import { artifactRefFor } from "./index.js";

describe("artifact handles", () => {
  test("maps internal rows to opaque bounded model-facing refs", () => {
    expect(artifactRefFor(42, "image", 2048)).toEqual({
      id: "a42",
      kind: "screenshot",
      byteSize: 2048,
      redacted: false,
    });
    expect(artifactRefFor(7, "video", -1, true)).toEqual({
      id: "a7",
      kind: "video",
      byteSize: 0,
      redacted: true,
    });
  });

  test("maps a redacted event track to the trace kind", () => {
    expect(artifactRefFor(3, "trace", 100, true)).toEqual({
      id: "a3",
      kind: "trace",
      byteSize: 100,
      redacted: true,
    });
  });

  test("does not expose log storage as a model-specific artifact kind", () => {
    expect(artifactRefFor(3, "log", 100)).toEqual({
      id: "a3",
      kind: "other",
      byteSize: 100,
      redacted: false,
    });
  });
});

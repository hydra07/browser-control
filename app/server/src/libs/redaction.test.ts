import { describe, expect, test } from "bun:test";
import { redactHeaders, redactPreview, redactValue } from "./redaction.js";

describe("redaction", () => {
  test("redacts credential fields while preserving safe structure", () => {
    expect(redactValue({ username: "alice", password: "do-not-store", nested: { accessToken: "secret" } })).toEqual({
      username: "alice",
      password: "[REDACTED:medium]",
      nested: { accessToken: "[REDACTED:short]" },
    });
  });

  test("removes credentials from previews and URLs", () => {
    expect(redactPreview("Bearer abc123 token=hidden status=401")).toBe(
      "Bearer [REDACTED] token=[REDACTED] status=401",
    );
    expect(redactPreview('{"password":"hidden","status":401}')).toBe('{"password":"[REDACTED]","status":401}');
    expect(redactValue("https://example.test/?token=hidden&keep=1")).toBe(
      "https://example.test/?token=%5BREDACTED%3Ashort%5D&keep=1",
    );
  });

  test("filters authentication headers", () => {
    expect(
      redactHeaders({ authorization: "Bearer secret", cookie: "session", "content-type": "application/json" }),
    ).toEqual({
      "content-type": "application/json",
    });
  });
});

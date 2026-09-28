import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractBearerToken, isAuthTokenValid, loadAuthToken, rotateAuthToken } from "./auth.js";

describe("daemon authentication", () => {
  const token = "a".repeat(64);

  test("compares valid tokens without accepting missing or wrong credentials", () => {
    expect(isAuthTokenValid(token, token)).toBe(true);
    expect(isAuthTokenValid(token, "b".repeat(64))).toBe(false);
    expect(isAuthTokenValid(token, undefined)).toBe(false);
    expect(isAuthTokenValid(token, "")).toBe(false);
  });

  test("extracts bearer tokens case-insensitively", () => {
    expect(extractBearerToken(new Request("http://127.0.0.1", { headers: { Authorization: `Bearer ${token}` } }))).toBe(
      token,
    );
    expect(extractBearerToken(new Request("http://127.0.0.1", { headers: { Authorization: "Basic abc" } }))).toBeNull();
  });

  test("persists across reloads and rotates explicitly", () => {
    const directory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "browsercontrol-auth-test-"));
    const path = join(directory, "daemon-auth-token");
    try {
      const first = loadAuthToken({ path, envToken: null });
      expect(first).toHaveLength(64);
      expect(loadAuthToken({ path, envToken: null })).toBe(first);
      expect(readFileSync(path, "utf8").trim()).toBe(first);

      const rotated = rotateAuthToken({ path, envToken: null });
      expect(rotated).toHaveLength(64);
      expect(rotated).not.toBe(first);
      expect(loadAuthToken({ path, envToken: null })).toBe(rotated);
      expect(isAuthTokenValid(first, rotated)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

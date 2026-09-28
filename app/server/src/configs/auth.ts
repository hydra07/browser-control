import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AUTH_TOKEN_PATH } from "./paths.js";

const AUTH_TOKEN_ENV = "BROWSERCONTROL_AUTH_TOKEN";
const AUTH_TOKEN_BYTES = 32;
const MIN_AUTH_TOKEN_LENGTH = AUTH_TOKEN_BYTES * 2;

function validateToken(token: string, source: string): string {
  const normalized = token.trim();
  if (normalized.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`${source} must contain at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
  }
  return normalized;
}

/** Overrides the token path or environment value for isolated lifecycle tests. */
export interface AuthTokenOptions {
  path?: string;
  envToken?: string | null;
}

function writePersistedToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}

function configuredToken(options: AuthTokenOptions): string | null {
  const override = "envToken" in options ? options.envToken : process.env[AUTH_TOKEN_ENV];
  return override?.trim() || null;
}

/** Loads the stable daemon secret, generating it only on the first run. */
export function loadAuthToken(options: AuthTokenOptions = {}): string {
  const path = options.path ?? AUTH_TOKEN_PATH;
  const override = configuredToken(options);
  if (override) return validateToken(override, AUTH_TOKEN_ENV);

  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf8").trim();
    return validateToken(persisted, path);
  }

  const generated = randomBytes(AUTH_TOKEN_BYTES).toString("hex");
  writePersistedToken(path, generated);
  return generated;
}

/** Rotates the persisted daemon secret; environment overrides cannot be rotated here. */
export function rotateAuthToken(options: AuthTokenOptions = {}): string {
  if (configuredToken(options)) {
    throw new Error(`${AUTH_TOKEN_ENV} is set; remove the override before rotating the persisted token`);
  }
  const generated = randomBytes(AUTH_TOKEN_BYTES).toString("hex");
  writePersistedToken(options.path ?? AUTH_TOKEN_PATH, generated);
  return generated;
}

/** Extracts a bearer token without exposing its value in an error message. */
export function extractBearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}

/** Compares authentication tokens without leaking expected-token length/content. */
export function isAuthTokenValid(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}

export { AUTH_TOKEN_ENV, AUTH_TOKEN_PATH };

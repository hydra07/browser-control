const SENSITIVE_KEY =
  /(?:password|passcode|pin|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|set-cookie|post[_-]?data|request[_-]?body|response[_-]?body)/i;
const SENSITIVE_QUERY_KEY =
  /(?:password|passcode|pin|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|code)/i;
const MAX_REDACTION_DEPTH = 8;

function lengthClass(value: string): string {
  if (value.length === 0) return "empty";
  if (value.length <= 8) return "short";
  if (value.length <= 64) return "medium";
  return "long";
}

function redactString(value: string): string {
  return `[REDACTED:${lengthClass(value)}]`;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, redactString(url.searchParams.get(key) ?? ""));
    }
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return value.replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  }
}

/** Redacts credential-like object fields while preserving safe structure and length classes. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return "[REDACTED:depth]";
  if (typeof value === "string") return redactUrl(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = typeof child === "string" ? redactString(child) : "[REDACTED]";
    } else {
      output[key] = redactValue(child, depth + 1);
    }
  }
  return output;
}

/** Removes credentials from a preview string without discarding safe debugging context. */
export function redactPreview(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:["']?(?:password|passcode|pin|token|secret|api[_-]?key|authorization|cookie|body)["']?)\s*[=:]\s*["']?)[^"'&\s,;}]*/gi,
      "$1[REDACTED]",
    );
}

/** Keeps non-sensitive network metadata while dropping auth/cookie headers. */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_KEY.test(name)) safe[name] = value;
  }
  return safe;
}

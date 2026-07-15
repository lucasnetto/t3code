export type CursorSdkErrorKind =
  | "authentication"
  | "rate-limit"
  | "configuration"
  | "network"
  | "timeout"
  | "unknown";

export interface CursorSdkErrorInfo {
  readonly kind: CursorSdkErrorKind;
  readonly message: string;
  readonly code?: string | undefined;
  readonly retryable: boolean;
}

export interface SafeCursorSdkCause {
  readonly _tag: "CursorSdkError";
  readonly kind: CursorSdkErrorKind;
  readonly message: string;
  readonly code?: string | undefined;
  readonly retryable: boolean;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function boundedMessage(value: unknown, secrets: ReadonlyArray<string>): string {
  const record = recordOf(value);
  const raw =
    value instanceof Error
      ? value.message
      : typeof record.message === "string"
        ? record.message
        : String(value);
  let redacted = raw
    .replace(/(CURSOR_API_KEY\s*[=:]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*[=:]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/(authorization\s*[=:]\s*bearer\s+)\S+/giu, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/giu, "$1[REDACTED]");
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, 1_000) || "Cursor SDK request failed.";
}

export function classifyCursorSdkError(
  error: unknown,
  secrets: ReadonlyArray<string> = [],
): CursorSdkErrorInfo {
  const record = recordOf(error);
  const name = error instanceof Error ? error.name : String(record.name ?? "");
  const code = typeof record.code === "string" ? record.code.slice(0, 128) : undefined;
  const status = typeof record.status === "number" ? record.status : undefined;
  const retryable = record.isRetryable === true;
  const message = boundedMessage(error, secrets);
  const search = `${name} ${code ?? ""} ${message}`.toLowerCase();

  let kind: CursorSdkErrorKind = "unknown";
  if (name === "RateLimitError" || status === 429 || /rate.?limit/u.test(search)) {
    kind = "rate-limit";
  } else if (
    name === "AuthenticationError" ||
    status === 401 ||
    /auth|unauthorized|api key/u.test(search)
  ) {
    kind = "authentication";
  } else if (/timeout|timed out|deadline/u.test(search)) {
    kind = "timeout";
  } else if (name === "NetworkError" || /network|connect|unavailable|econn/u.test(search)) {
    kind = "network";
  } else if (name === "ConfigurationError" || status === 400 || status === 404) {
    kind = "configuration";
  }

  return {
    kind,
    message,
    ...(code ? { code } : {}),
    retryable,
  };
}

/**
 * Converts an SDK failure into the only representation that may cross the
 * provider boundary. In particular, this deliberately drops the SDK error's
 * original cause/context because those objects can retain request metadata and
 * credentials.
 */
export function safeCursorSdkCause(
  error: unknown,
  secrets: ReadonlyArray<string> = [],
): SafeCursorSdkCause {
  return { _tag: "CursorSdkError", ...classifyCursorSdkError(error, secrets) };
}

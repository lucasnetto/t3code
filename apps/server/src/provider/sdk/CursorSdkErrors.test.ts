import { describe, expect, it } from "vite-plus/test";

import { classifyCursorSdkError, safeCursorSdkCause } from "./CursorSdkErrors.ts";

describe("classifyCursorSdkError", () => {
  it.each([
    [{ name: "AuthenticationError", status: 401 }, "authentication"],
    [{ name: "RateLimitError", status: 429 }, "rate-limit"],
    [{ name: "NetworkError", code: "ECONNRESET", isRetryable: true }, "network"],
    [{ name: "ConfigurationError", status: 400 }, "configuration"],
    [new Error("request timed out"), "timeout"],
  ] as const)("classifies %o as %s", (cause, kind) => {
    expect(classifyCursorSdkError(cause)).toMatchObject({ kind });
  });

  it("bounds and redacts API keys from diagnostic messages", () => {
    const info = classifyCursorSdkError(
      new Error(`CURSOR_API_KEY=super-secret ${"x".repeat(2_000)}`),
    );

    expect(info.message).not.toContain("super-secret");
    expect(info.message).toContain("[REDACTED]");
    expect(info.message.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps explicit rate-limit errors distinct when their message mentions an API key", () => {
    const error = new Error("API key rate limit exceeded");
    error.name = "RateLimitError";

    expect(classifyCursorSdkError(error).kind).toBe("rate-limit");
  });

  it("drops raw SDK error context before a failure crosses the provider boundary", () => {
    const cause = Object.assign(new Error("CURSOR_API_KEY=super-secret request failed"), {
      context: { headers: { authorization: "Bearer super-secret" } },
      code: "UNAUTHENTICATED",
    });

    const safe = safeCursorSdkCause(cause);

    expect(JSON.stringify(safe)).not.toContain("super-secret");
    expect(safe).toMatchObject({
      _tag: "CursorSdkError",
      code: "UNAUTHENTICATED",
      message: "CURSOR_API_KEY=[REDACTED] request failed",
    });
  });

  it("redacts bearer credentials and the exact configured secret regardless of labels", () => {
    const safe = safeCursorSdkCause(
      new Error("upstream rejected literal-secret; Authorization: Bearer second-secret"),
      ["literal-secret"],
    );

    expect(safe.message).not.toContain("literal-secret");
    expect(safe.message).not.toContain("second-secret");
    expect(safe.message).toContain("[REDACTED]");
  });
});

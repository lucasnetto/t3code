import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

const makeInvocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
  expiresAt: 2,
});

it.effect("returns the scoped credential context when preview capability is granted", () => {
  const invocation = makeInvocation(new Set(["preview"]));

  return Effect.gen(function* () {
    const resolved = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );

    expect(resolved).toBe(invocation);
  });
});

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation = makeInvocation(new Set());

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("returns the scoped credential context when task capability is granted", () => {
  const invocation = makeInvocation(new Set(["task"]));

  return Effect.gen(function* () {
    const resolved = yield* McpInvocationContext.requireMcpCapability("task").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );

    expect(resolved).toBe(invocation);
  });
});

it.effect("reports capability-neutral evidence when task capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
    expiresAt: 2,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("task").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpInvocationContext.McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "task",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the task capability.");
  });
});

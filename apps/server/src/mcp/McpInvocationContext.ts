import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type McpCapability = "preview" | "task";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export class McpCapabilityUnavailableError extends Schema.TaggedErrorClass<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: Schema.Literals(["preview", "task"]),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: Schema.String,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

const requireMcpCapabilityEffect = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (invocation.capabilities.has(capability)) {
    return invocation;
  }
  const evidence = {
    capability,
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  if (capability === "preview") {
    return yield* new PreviewAutomationUnavailableError({
      ...evidence,
      capability,
    });
  }
  return yield* new McpCapabilityUnavailableError(evidence);
});

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "task",
): Effect.Effect<McpInvocationScope, McpCapabilityUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: McpCapability,
): Effect.Effect<
  McpInvocationScope,
  PreviewAutomationUnavailableError | McpCapabilityUnavailableError,
  McpInvocationContext
>;
export function requireMcpCapability(capability: McpCapability) {
  return requireMcpCapabilityEffect(capability);
}

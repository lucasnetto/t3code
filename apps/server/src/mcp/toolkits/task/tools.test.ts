import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-task-tools");
const taskId = TaskId.make("task-1");
const callerThreadId = ThreadId.make("thread-caller");
const childThreadId = ThreadId.make("thread-child");
const projectId = ProjectId.make("project-api");
const createdAt = "2026-07-23T12:00:00.000Z";

const thread = (
  id: ThreadId,
  createdBy: { readonly kind: "user" } | { readonly kind: "agent" },
): OrchestrationThreadShell => ({
  id,
  projectId,
  title: id === callerThreadId ? "Coordinator" : "API worker",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: id === childThreadId ? "feature/api" : null,
  worktreePath: id === childThreadId ? "/tmp/task/worktrees/child-api" : null,
  latestTurn:
    id === childThreadId
      ? {
          turnId: TurnId.make("turn-child"),
          state: "running",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  taskContext: {
    taskId,
    createdBy:
      createdBy.kind === "user"
        ? createdBy
        : {
            kind: "agent",
            threadId: callerThreadId,
            turnId: TurnId.make("turn-parent"),
          },
  },
});

const caller = thread(callerThreadId, { kind: "user" });
const child = thread(childThreadId, { kind: "agent" });
const query = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      Option.fromNullishOr([caller, child].find((candidate) => candidate.id === threadId)),
    ),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 1,
      tasks: [
        {
          id: taskId,
          title: "Coordinate feature",
          status: "active" as const,
          rootPath: "/tmp/task",
          workspaceProjectId: ProjectId.make("project-task"),
          approvedProjectIds: [projectId],
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
        },
      ],
      projects: [
        {
          id: projectId,
          title: "API",
          workspaceRoot: "/tmp/api",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      ],
      threads: [caller, child],
      updatedAt: createdAt,
    }),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const TestLayer = McpHttpServer.TaskToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query)),
  Layer.provide(
    Layer.succeed(CheckpointDiffQuery.CheckpointDiffQuery, {
      getTurnDiff: () => Effect.die("unused"),
      getFullThreadDiff: () => Effect.die("unused"),
    }),
  ),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "task-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) => ({
  environmentId,
  threadId: callerThreadId,
  providerSessionId: "provider-session-task-tools",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

it.effect("lists only repositories and threads in the credential's task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const repositories = yield* server
        .callTool({ name: "task_list_repositories", arguments: {} })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(repositories.isError).toBe(false);
      expect(repositories.structuredContent).toEqual({
        taskId,
        repositories: [{ projectId, title: "API", workspaceRoot: "/tmp/api" }],
      });

      const threads = yield* server
        .callTool({ name: "task_list_threads", arguments: {} })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(threads.isError).toBe(false);
      expect(threads.structuredContent).toMatchObject({
        taskId,
        threads: [
          { threadId: callerThreadId, origin: { kind: "user" }, status: "idle" },
          {
            threadId: childThreadId,
            origin: { kind: "agent", threadId: callerThreadId },
            status: "working",
          },
        ],
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects task tools for credentials without the task capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "task_list_threads", arguments: {} })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["preview"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain(
        "This provider session does not have task orchestration access.",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

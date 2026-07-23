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
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as TaskWorkspaceService from "../../../tasks/TaskWorkspaceService.ts";
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
  latestTurn: {
    turnId: TurnId.make(id === childThreadId ? "turn-child" : "turn-caller"),
    state: "running",
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    assistantMessageId: null,
  },
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
        {
          id: ProjectId.make("project-task"),
          title: "Task workspace",
          workspaceRoot: "/tmp/task",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
          visibility: "internal-task" as const,
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

const makeCoordinationTestLayer = (
  dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand>,
  options?: {
    readonly query?: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
    readonly runStackedAction?: GitManager.GitManager["Service"]["runStackedAction"];
  },
) =>
  McpHttpServer.TaskCoordinationToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, options?.query ?? query),
    ),
    Layer.provide(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: import("@t3tools/contracts").OrchestrationCommand) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        GitWorkflowService.GitWorkflowService,
        {} as GitWorkflowService.GitWorkflowService["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(GitManager.GitManager, {
        runStackedAction: options?.runStackedAction ?? (() => Effect.die("unused")),
      } as unknown as GitManager.GitManager["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        ProjectSetupScriptRunner.ProjectSetupScriptRunner,
        {} as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(TaskWorkspaceService.TaskWorkspaceService, {
        newTaskRoot: () => "/tmp/task",
        managedWorktreePath: () => "/tmp/task/worktrees/unused",
        prepare: () => Effect.void,
      }),
    ),
    Layer.provide(NodeServices.layer),
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
          { threadId: callerThreadId, origin: { kind: "user" }, status: "working" },
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

it.effect("spawns a durable agent thread with the exact caller message", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            message: "Investigate the failing integration\nDo not change unrelated files.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.agent.create",
        "thread.turn.start",
      ]);
      const create = dispatchedCommands[0];
      expect(create?.type).toBe("thread.agent.create");
      if (create?.type === "thread.agent.create") {
        expect(create.spawningThreadId).toBe(callerThreadId);
        expect(create.spawningTurnId).toBe(TurnId.make("turn-caller"));
        expect(create.projectId).toBe(ProjectId.make("project-task"));
      }
      const turn = dispatchedCommands[1];
      expect(turn?.type).toBe("thread.turn.start");
      if (turn?.type === "thread.turn.start") {
        expect(turn.message.text).toBe(
          "Investigate the failing integration\nDo not change unrelated files.",
        );
      }
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("creates a pull request through the target thread checkout", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const readyChild = {
    ...child,
    latestTurn: child.latestTurn
      ? {
          ...child.latestTurn,
          state: "completed" as const,
          completedAt: createdAt,
        }
      : null,
  };
  const actionInputs: Array<import("@t3tools/contracts").GitRunStackedActionInput> = [];
  const readyQuery = {
    ...query,
    getShellSnapshot: () =>
      query
        .getShellSnapshot()
        .pipe(Effect.map((snapshot) => ({ ...snapshot, threads: [caller, readyChild] }))),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.fromNullishOr([caller, readyChild].find((candidate) => candidate.id === threadId)),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_create_pull_request",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(actionInputs).toEqual([
        {
          actionId: expect.stringMatching(/^task:pr:/),
          cwd: "/tmp/task/worktrees/child-api",
          action: "create_pr",
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        threadId: childThreadId,
        status: "created",
        url: "https://example.test/pull/42",
        number: 42,
      });
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, {
        query: readyQuery,
        runStackedAction: (input) =>
          Effect.sync(() => {
            actionInputs.push(input);
            return {
              action: "create_pr" as const,
              branch: { status: "skipped_not_requested" as const },
              commit: { status: "skipped_not_requested" as const },
              push: { status: "pushed" as const },
              pr: {
                status: "created" as const,
                url: "https://example.test/pull/42",
                number: 42,
                baseBranch: "main",
                headBranch: "feature/api",
                title: "Ship API",
              },
              toast: {
                title: "Pull request created",
                cta: {
                  kind: "open_pr" as const,
                  label: "Open pull request",
                  url: "https://example.test/pull/42",
                },
              },
            };
          }),
      }),
    ),
  );
});

it.effect("requests a checkpoint revert only for an idle agent-created thread", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const readyChild = {
    ...child,
    latestTurn: child.latestTurn
      ? {
          ...child.latestTurn,
          state: "completed" as const,
          completedAt: createdAt,
        }
      : null,
  };
  const readyQuery = {
    ...query,
    getShellSnapshot: () =>
      query
        .getShellSnapshot()
        .pipe(Effect.map((snapshot) => ({ ...snapshot, threads: [caller, readyChild] }))),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.fromNullishOr([caller, readyChild].find((candidate) => candidate.id === threadId)),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_revert_thread",
          arguments: { threadId: childThreadId, turnCount: 1 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(dispatchedCommands).toEqual([
        {
          type: "thread.checkpoint.revert",
          commandId: expect.stringMatching(/^task:revert:/),
          threadId: childThreadId,
          turnCount: 1,
          createdAt: expect.any(String),
        },
      ]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands, { query: readyQuery })));
});

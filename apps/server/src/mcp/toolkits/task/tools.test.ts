import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  TurnId,
  VcsUnsupportedOperationError,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointRefUnavailableError } from "../../../checkpointing/Errors.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as TaskWorkspaceService from "../../../tasks/TaskWorkspaceService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-task-tools");
const taskId = TaskId.make("task-1");
const otherTaskId = TaskId.make("task-2");
const callerThreadId = ThreadId.make("thread-caller");
const childThreadId = ThreadId.make("thread-child");
const archivedThreadId = ThreadId.make("thread-archived");
const deletedThreadId = ThreadId.make("thread-deleted");
const crossTaskThreadId = ThreadId.make("thread-cross-task");
const projectId = ProjectId.make("project-api");
const secondProjectId = ProjectId.make("project-web");
const unapprovedProjectId = ProjectId.make("project-unapproved");
const taskWorkspaceProjectId = ProjectId.make("project-task");
const createdAt = "2026-07-23T12:00:00.000Z";
const archivedAt = "2026-07-23T13:00:00.000Z";

const thread = (
  id: ThreadId,
  createdBy: { readonly kind: "user" } | { readonly kind: "agent" },
  options: {
    readonly archivedAt?: string | null;
    readonly taskId?: TaskId;
    readonly sessionStatus?: NonNullable<OrchestrationThreadShell["session"]>["status"];
    readonly activeTurnId?: TurnId | null;
    readonly latestTurnState?: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"];
  } = {},
): OrchestrationThreadShell => {
  const turnId = TurnId.make(id === childThreadId ? "turn-child" : "turn-caller");
  const sessionStatus = options.sessionStatus ?? "running";
  const activeTurnId =
    options.activeTurnId === undefined
      ? sessionStatus === "running"
        ? turnId
        : null
      : options.activeTurnId;
  return {
    id,
    projectId: id === callerThreadId ? taskWorkspaceProjectId : projectId,
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
      turnId,
      state: options.latestTurnState ?? (sessionStatus === "running" ? "running" : "completed"),
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: sessionStatus === "running" ? null : createdAt,
      assistantMessageId: null,
    },
    createdAt,
    updatedAt: createdAt,
    archivedAt: options.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: id,
      status: sessionStatus,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId,
      lastError: null,
      updatedAt: createdAt,
    },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    taskContext: {
      taskId: options.taskId ?? taskId,
      createdBy:
        createdBy.kind === "user"
          ? createdBy
          : {
              kind: "agent",
              threadId: callerThreadId,
              turnId: TurnId.make("turn-parent"),
            },
    },
  };
};

const caller = thread(callerThreadId, { kind: "user" });
const child = thread(childThreadId, { kind: "agent" });
const archived = thread(archivedThreadId, { kind: "agent" }, { archivedAt });
const crossTask = thread(crossTaskThreadId, { kind: "agent" }, { taskId: otherTaskId });

const transcriptMessage = (
  id: string,
  text: string,
  options: { readonly streaming?: boolean; readonly updatedAt?: string } = {},
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  turnId: TurnId.make(`turn-${id}`),
  streaming: options.streaming ?? false,
  createdAt,
  updatedAt: options.updatedAt ?? createdAt,
});

const childDetail = {
  ...child,
  deletedAt: null,
  messages: [transcriptMessage("message-active", "Active transcript")],
  proposedPlans: [],
  activities: [],
  checkpoints: [
    {
      turnId: TurnId.make("turn-child"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("checkpoint-child-1"),
      status: "ready" as const,
      files: [],
      assistantMessageId: null,
      completedAt: createdAt,
    },
  ],
};

const query = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      Option.fromNullishOr([caller, child].find((candidate) => candidate.id === threadId)),
    ),
  getThreadDetailById: (threadId: ThreadId) =>
    Effect.succeed(Option.fromNullishOr(threadId === childThreadId ? childDetail : undefined)),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 1,
      tasks: [
        {
          id: taskId,
          title: "Coordinate feature",
          status: "active" as const,
          rootPath: "/tmp/task",
          workspaceProjectId: taskWorkspaceProjectId,
          approvedProjectIds: [projectId, secondProjectId],
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
          id: unapprovedProjectId,
          title: "Unapproved",
          workspaceRoot: "/tmp/unapproved",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: secondProjectId,
          title: "Web",
          workspaceRoot: "/tmp/web",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: taskWorkspaceProjectId,
          title: "Internal task workspace",
          workspaceRoot: "/tmp/task",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
          visibility: "internal-task" as const,
        },
      ],
      threads: [caller, child, archived, crossTask],
      updatedAt: createdAt,
    }),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const makeQuery = (
  threads:
    | ReadonlyArray<OrchestrationThreadShell>
    | (() => ReadonlyArray<OrchestrationThreadShell>),
): ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] =>
  ({
    getThreadShellById: (threadId: ThreadId) =>
      Effect.sync(() => {
        const currentThreads = typeof threads === "function" ? threads() : threads;
        return Option.fromNullishOr(currentThreads.find((candidate) => candidate.id === threadId));
      }),
    getShellSnapshot: () =>
      query.getShellSnapshot().pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          threads: typeof threads === "function" ? threads() : threads,
        })),
      ),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const currentBranchRefPage = (currentBranch = "main") =>
  Effect.succeed({
    refs: [
      {
        name: currentBranch,
        isRemote: false,
        current: true,
        isDefault: true,
        worktreePath: "/tmp/api",
      },
    ],
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: 1,
  });

const createdWorktreeResult = (refName: string, path: string) => ({
  worktree: { refName, path },
  createdBranch: {
    refName,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
});

const successfulCheckpointDiffQuery: CheckpointDiffQuery.CheckpointDiffQuery["Service"] = {
  getTurnDiff: ({ threadId, fromTurnCount, toTurnCount }) =>
    Effect.succeed({
      threadId,
      fromTurnCount,
      toTurnCount,
      diff: "diff --git a/active.ts b/active.ts",
    }),
  getFullThreadDiff: () => Effect.die("unused"),
};

const makeTestLayer = (checkpointDiffQuery: CheckpointDiffQuery.CheckpointDiffQuery["Service"]) =>
  McpHttpServer.TaskToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query)),
    Layer.provide(Layer.succeed(CheckpointDiffQuery.CheckpointDiffQuery, checkpointDiffQuery)),
  );

const TestLayer = makeTestLayer(successfulCheckpointDiffQuery);

const makeCoordinationTestLayer = (
  dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand>,
  projectionQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] = query,
  gitWorkflow: GitWorkflowService.GitWorkflowService["Service"] = {} as GitWorkflowService.GitWorkflowService["Service"],
  dispatchOverride?: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"],
  setupRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"] = {} as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"],
  gitManager: GitManager.GitManager["Service"] = {
    runStackedAction: () => Effect.die("unused"),
  } as unknown as GitManager.GitManager["Service"],
) =>
  McpHttpServer.TaskCoordinationToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projectionQuery)),
    Layer.provide(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch:
          dispatchOverride ??
          ((command: import("@t3tools/contracts").OrchestrationCommand) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            })),
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
    ),
    Layer.provide(Layer.succeed(GitWorkflowService.GitWorkflowService, gitWorkflow)),
    Layer.provide(Layer.succeed(GitManager.GitManager, gitManager)),
    Layer.provide(Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, setupRunner)),
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

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
  threadId = callerThreadId,
) => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-task-tools",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const toolErrorText = (result: McpSchema.CallToolResult): string => {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
};

it.effect("lists only approved repositories and active same-task threads", () =>
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
        repositories: [
          { projectId, title: "API", workspaceRoot: "/tmp/api" },
          { projectId: secondProjectId, title: "Web", workspaceRoot: "/tmp/web" },
        ],
        nextCursor: null,
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
      expect(threads.structuredContent).toEqual({
        taskId,
        threads: [
          {
            threadId: callerThreadId,
            target: { kind: "task-root" },
            title: "Coordinator",
            origin: { kind: "user" },
            status: "working",
            branch: null,
            worktreePath: null,
            updatedAt: createdAt,
          },
          {
            threadId: childThreadId,
            target: { kind: "repository", projectId },
            title: "API worker",
            origin: {
              kind: "agent",
              threadId: callerThreadId,
              turnId: TurnId.make("turn-parent"),
            },
            status: "working",
            branch: "feature/api",
            worktreePath: "/tmp/task/worktrees/child-api",
            updatedAt: createdAt,
          },
        ],
        nextCursor: null,
      });

      const taskRootStatus = yield* server
        .callTool({
          name: "task_get_thread_status",
          arguments: { threadId: callerThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(taskRootStatus.isError).toBe(false);
      expect(taskRootStatus.structuredContent).toEqual({
        threadId: callerThreadId,
        target: { kind: "task-root" },
        title: "Coordinator",
        origin: { kind: "user" },
        status: "working",
        branch: null,
        worktreePath: null,
        updatedAt: createdAt,
      });

      const repositoryStatus = yield* server
        .callTool({
          name: "task_get_thread_status",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(repositoryStatus.isError).toBe(false);
      expect(repositoryStatus.structuredContent).toEqual({
        threadId: childThreadId,
        target: { kind: "repository", projectId },
        title: "API worker",
        origin: {
          kind: "agent",
          threadId: callerThreadId,
          turnId: TurnId.make("turn-parent"),
        },
        status: "working",
        branch: "feature/api",
        worktreePath: "/tmp/task/worktrees/child-api",
        updatedAt: createdAt,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("pages repository and thread lists through opaque bounded continuations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (name: string, arguments_: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: arguments_ })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(new Set(["task"])),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const firstRepositories = yield* call("task_list_repositories", { maxItems: 1 });
      expect(firstRepositories.isError).toBe(false);
      expect(firstRepositories.structuredContent).toMatchObject({
        taskId,
        repositories: [{ projectId }],
      });
      const repositoryCursor =
        firstRepositories.structuredContent &&
        "nextCursor" in firstRepositories.structuredContent &&
        typeof firstRepositories.structuredContent.nextCursor === "string"
          ? firstRepositories.structuredContent.nextCursor
          : undefined;
      expect(repositoryCursor).toBeDefined();

      const secondRepositories = yield* call("task_list_repositories", {
        cursor: repositoryCursor,
        maxItems: 1,
      });
      expect(secondRepositories.isError).toBe(false);
      expect(secondRepositories.structuredContent).toEqual({
        taskId,
        repositories: [{ projectId: secondProjectId, title: "Web", workspaceRoot: "/tmp/web" }],
        nextCursor: null,
      });

      const firstThreads = yield* call("task_list_threads", { maxItems: 1 });
      expect(firstThreads.isError).toBe(false);
      expect(firstThreads.structuredContent).toMatchObject({
        taskId,
        threads: [{ threadId: callerThreadId }],
      });
      const threadCursor =
        firstThreads.structuredContent &&
        "nextCursor" in firstThreads.structuredContent &&
        typeof firstThreads.structuredContent.nextCursor === "string"
          ? firstThreads.structuredContent.nextCursor
          : undefined;
      expect(threadCursor).toBeDefined();

      const secondThreads = yield* call("task_list_threads", {
        cursor: threadCursor,
        maxItems: 1,
      });
      expect(secondThreads.isError).toBe(false);
      expect(secondThreads.structuredContent).toMatchObject({
        taskId,
        threads: [{ threadId: childThreadId }],
        nextCursor: null,
      });

      const wrongList = yield* call("task_list_threads", {
        cursor: repositoryCursor,
        maxItems: 1,
      });
      expect(wrongList.isError).toBe(true);
      const content = wrongList.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain("The list cursor is invalid.");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects invalid, cross-task, and stale list cursors", () =>
  Effect.gen(function* () {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const invalid = yield* Effect.flip(
      __testing.paginateList(
        items,
        "not-base64-json",
        1,
        taskId,
        "repositories",
        (item) => item.id,
        "task.list_repositories",
      ),
    );
    expect(invalid.detail).toBe("The list cursor is invalid.");

    const incompatibleCursor = Buffer.from(
      '{"v":2,"taskId":"task-1","collection":"repositories","anchorId":"a","anchorIndex":0}',
      "utf8",
    ).toString("base64url");
    const incompatible = yield* Effect.flip(
      __testing.paginateList(
        items,
        incompatibleCursor,
        1,
        taskId,
        "repositories",
        (item) => item.id,
        "task.list_repositories",
      ),
    );
    expect(incompatible.detail).toBe("The list cursor is invalid.");

    const first = yield* __testing.paginateList(
      items,
      undefined,
      1,
      taskId,
      "repositories",
      (item) => item.id,
      "task.list_repositories",
    );
    expect(first.items).toEqual([{ id: "a" }]);
    expect(first.nextCursor).not.toBeNull();

    const crossTask = yield* Effect.flip(
      __testing.paginateList(
        items,
        first.nextCursor ?? undefined,
        1,
        otherTaskId,
        "repositories",
        (item) => item.id,
        "task.list_repositories",
      ),
    );
    expect(crossTask.detail).toBe("The list cursor is invalid.");

    const stale = yield* Effect.flip(
      __testing.paginateList(
        [items[1]!, items[0]!, items[2]!],
        first.nextCursor ?? undefined,
        1,
        taskId,
        "repositories",
        (item) => item.id,
        "task.list_repositories",
      ),
    );
    expect(stale.detail).toBe("The list cursor is stale.");

    const appended = yield* __testing.paginateList(
      [...items, { id: "d" }],
      first.nextCursor ?? undefined,
      10,
      taskId,
      "repositories",
      (item) => item.id,
      "task.list_repositories",
    );
    expect(appended.items).toEqual([{ id: "b" }, { id: "c" }, { id: "d" }]);
    expect(appended.nextCursor).toBeNull();
  }),
);

it.effect("clamps list page sizes and never returns more than the hard cap", () =>
  Effect.gen(function* () {
    expect(__testing.listLimit(undefined)).toBe(50);
    expect(__testing.listLimit(0)).toBe(1);
    expect(__testing.listLimit(1)).toBe(1);
    expect(__testing.listLimit(100)).toBe(100);
    expect(__testing.listLimit(101)).toBe(100);

    const items = Array.from({ length: 101 }, (_, index) => ({ id: `item-${index}` }));
    const page = yield* __testing.paginateList(
      items,
      undefined,
      __testing.listLimit(10_000),
      taskId,
      "threads",
      (item) => item.id,
      "task.list_threads",
    );
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();

    const final = yield* __testing.paginateList(
      items,
      page.nextCursor ?? undefined,
      __testing.listLimit(10_000),
      taskId,
      "threads",
      (item) => item.id,
      "task.list_threads",
    );
    expect(final.items).toEqual([{ id: "item-100" }]);
    expect(final.nextCursor).toBeNull();
  }),
);

it.effect("returns status only for active task threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const active = yield* server
        .callTool({
          name: "task_get_thread_status",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(active.isError).toBe(false);
      expect(active.structuredContent).toMatchObject({
        threadId: childThreadId,
        status: "working",
      });

      yield* Effect.forEach([archivedThreadId, deletedThreadId, crossTaskThreadId], (threadId) =>
        Effect.gen(function* () {
          const result = yield* server
            .callTool({
              name: "task_get_thread_status",
              arguments: { threadId },
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(new Set(["task"])),
              ),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(result.isError).toBe(true);
          const content = result.content[0];
          expect(content?.type).toBe("text");
          expect(content?.type === "text" ? content.text : "").toContain(
            `Thread '${threadId}' is outside the current task.`,
          );
        }),
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads transcripts only for active task threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const active = yield* server
        .callTool({
          name: "task_read_thread",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(active.isError).toBe(false);
      expect(active.structuredContent).toMatchObject({
        threadId: childThreadId,
        messages: [{ text: "Active transcript" }],
        nextCursor: null,
        truncated: false,
      });

      yield* Effect.forEach([archivedThreadId, deletedThreadId, crossTaskThreadId], (threadId) =>
        Effect.gen(function* () {
          const result = yield* server
            .callTool({
              name: "task_read_thread",
              arguments: { threadId },
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(new Set(["task"])),
              ),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(result.isError).toBe(true);
          const content = result.content[0];
          expect(content?.type).toBe("text");
          expect(content?.type === "text" ? content.text : "").toContain(
            `Thread '${threadId}' is outside the current task.`,
          );
        }),
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("pages transcripts through the registered handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const first = yield* server
        .callTool({
          name: "task_read_thread",
          arguments: { threadId: childThreadId, maxChars: 6 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        threadId: childThreadId,
        messages: [{ text: "Active" }],
        truncated: true,
      });
      const cursor =
        first.structuredContent && "nextCursor" in first.structuredContent
          ? first.structuredContent.nextCursor
          : null;
      expect(cursor).not.toBeNull();

      const second = yield* server
        .callTool({
          name: "task_read_thread",
          arguments: {
            threadId: childThreadId,
            cursor: typeof cursor === "string" ? cursor : undefined,
            maxChars: 20,
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(second.isError).toBe(false);
      expect(second.structuredContent).toMatchObject({
        threadId: childThreadId,
        messages: [{ text: " transcript" }],
        nextCursor: null,
        truncated: false,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads checkpoint diffs only for active task threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const active = yield* server
        .callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(active.isError).toBe(false);
      expect(active.structuredContent).toEqual({
        threadId: childThreadId,
        fromTurn: 0,
        toTurn: 1,
        diff: "diff --git a/active.ts b/active.ts",
        truncated: false,
      });

      yield* Effect.forEach([archivedThreadId, deletedThreadId, crossTaskThreadId], (threadId) =>
        Effect.gen(function* () {
          const result = yield* server
            .callTool({
              name: "task_get_thread_diff",
              arguments: { threadId },
            })
            .pipe(
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                invocation(new Set(["task"])),
              ),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(result.isError).toBe(true);
          const content = result.content[0];
          expect(content?.type).toBe("text");
          expect(content?.type === "text" ? content.text : "").toContain(
            `Thread '${threadId}' is outside the current task.`,
          );
        }),
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("classifies a missing repository checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: callerThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain("[checkout-unavailable]");
      expect(content?.type === "text" ? content.text : "").not.toContain("/tmp/task/worktrees");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("classifies an invalid checkpoint turn range before querying storage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* Effect.forEach(
        [
          { threadId: childThreadId, fromTurn: 2, toTurn: 1 },
          { threadId: childThreadId, fromTurn: 0, toTurn: 2 },
        ],
        (arguments_) =>
          Effect.gen(function* () {
            const result = yield* server
              .callTool({
                name: "task_get_thread_diff",
                arguments: arguments_,
              })
              .pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  invocation(new Set(["task"])),
                ),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

            expect(result.isError).toBe(true);
            const content = result.content[0];
            expect(content?.type).toBe("text");
            expect(content?.type === "text" ? content.text : "").toContain("[invalid-range]");
          }),
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("forwards explicit diff ranges and caps diff output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: childThreadId, fromTurn: 1, toTurn: 1 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threadId: childThreadId,
        fromTurn: 1,
        toTurn: 1,
        truncated: true,
      });
      const diff =
        result.structuredContent && "diff" in result.structuredContent
          ? result.structuredContent.diff
          : null;
      expect(typeof diff === "string" ? diff.length : null).toBe(32_000);
    }),
  ).pipe(
    Effect.provide(
      makeTestLayer({
        getTurnDiff: ({ threadId, fromTurnCount, toTurnCount }) =>
          Effect.succeed({
            threadId,
            fromTurnCount,
            toTurnCount,
            diff: "x".repeat(32_001),
          }),
        getFullThreadDiff: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("preserves missing checkpoint refs as checkpoint-unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain("[checkpoint-unavailable]");
      expect(content?.type === "text" ? content.text : "").not.toContain("checkpoint-child-secret");
    }),
  ).pipe(
    Effect.provide(
      makeTestLayer({
        getTurnDiff: () =>
          Effect.fail(
            new CheckpointRefUnavailableError({
              operation: "CheckpointDiffQuery.getTurnDiff",
              threadId: childThreadId,
              turnCount: 1,
              checkpoint: "to",
            }),
          ),
        getFullThreadDiff: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("generalizes checkpoint backend failures as diff-failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: childThreadId },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain("[diff-failed]");
      expect(content?.type === "text" ? content.text : "").not.toContain("backend-secret-detail");
    }),
  ).pipe(
    Effect.provide(
      makeTestLayer({
        getTurnDiff: () =>
          Effect.fail(
            new VcsUnsupportedOperationError({
              operation: "CheckpointStore.diffCheckpoints",
              kind: "git",
              detail: "backend-secret-detail",
            }),
          ),
        getFullThreadDiff: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("rejects every task read tool without the task capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const calls = [
        server.callTool({ name: "task_list_repositories", arguments: {} }),
        server.callTool({ name: "task_list_threads", arguments: {} }),
        server.callTool({
          name: "task_get_thread_status",
          arguments: { threadId: childThreadId },
        }),
        server.callTool({
          name: "task_read_thread",
          arguments: { threadId: childThreadId },
        }),
        server.callTool({
          name: "task_get_thread_diff",
          arguments: { threadId: childThreadId },
        }),
      ];

      yield* Effect.forEach(calls, (call) =>
        Effect.gen(function* () {
          const result = yield* call.pipe(
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
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects task tools when the calling thread was agent-created", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "task_list_repositories", arguments: {} })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"]), childThreadId),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      expect(content?.type === "text" ? content.text : "").toContain(
        "Task tools require a user-created thread in an active task.",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("maps each projected thread state to its task status", () =>
  Effect.sync(() => {
    const latestTurn = child.latestTurn;
    expect(latestTurn).not.toBeNull();
    expect(__testing.statusForThread(caller)).toBe("working");
    expect(__testing.statusForThread(child)).toBe("working");
    expect(
      __testing.statusForThread({
        ...child,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
    expect(
      __testing.statusForThread({
        ...child,
        hasPendingUserInput: true,
      }),
    ).toBe("input");
    expect(
      __testing.statusForThread({
        ...child,
        latestTurn: latestTurn ? { ...latestTurn, state: "error" } : null,
      }),
    ).toBe("failed");
    expect(
      __testing.statusForThread({
        ...caller,
        latestTurn: caller.latestTurn
          ? { ...caller.latestTurn, state: "completed", completedAt: createdAt }
          : null,
        session: {
          threadId: callerThreadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "provider failed",
          updatedAt: createdAt,
        },
      }),
    ).toBe("failed");
    expect(
      __testing.statusForThread({
        ...child,
        latestTurn: latestTurn ? { ...latestTurn, state: "completed" } : null,
      }),
    ).toBe("ready");
  }),
);

it.effect("pages through one oversized transcript message without losing text", () =>
  Effect.gen(function* () {
    const messages = [transcriptMessage("message-1", "abcdefghij")];

    const first = yield* __testing.paginateTranscript(messages, undefined, 4, "task.read_thread");
    expect(first.messages.map((message) => message.text)).toEqual(["abcd"]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.truncated).toBe(true);

    const second = yield* __testing.paginateTranscript(
      messages,
      first.nextCursor ?? undefined,
      4,
      "task.read_thread",
    );
    expect(second.messages.map((message) => message.text)).toEqual(["efgh"]);
    expect(second.nextCursor).not.toBeNull();
    expect(second.truncated).toBe(true);

    const third = yield* __testing.paginateTranscript(
      messages,
      second.nextCursor ?? undefined,
      4,
      "task.read_thread",
    );
    expect(third.messages.map((message) => message.text)).toEqual(["ij"]);
    expect(third.nextCursor).toBeNull();
    expect(third.truncated).toBe(false);

    expect(
      [...first.messages, ...second.messages, ...third.messages]
        .map((message) => message.text)
        .join(""),
    ).toBe("abcdefghij");
  }),
);

it.effect("advances to the next message at an exact page boundary", () =>
  Effect.gen(function* () {
    const messages = [
      transcriptMessage("message-1", "abcd"),
      transcriptMessage("message-2", "efgh"),
    ];

    const first = yield* __testing.paginateTranscript(messages, undefined, 4, "task.read_thread");
    expect(first.messages.map((message) => message.text)).toEqual(["abcd"]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.truncated).toBe(true);

    const second = yield* __testing.paginateTranscript(
      messages,
      first.nextCursor ?? undefined,
      4,
      "task.read_thread",
    );
    expect(second.messages.map((message) => message.text)).toEqual(["efgh"]);
    expect(second.nextCursor).toBeNull();
    expect(second.truncated).toBe(false);
  }),
);

it.effect("counts and slices transcript pages using JavaScript UTF-16 character offsets", () =>
  Effect.gen(function* () {
    const text = "A😀B";
    expect(text.length).toBe(4);
    const messages = [transcriptMessage("message-unicode", text)];

    const first = yield* __testing.paginateTranscript(messages, undefined, 2, "task.read_thread");
    const second = yield* __testing.paginateTranscript(
      messages,
      first.nextCursor ?? undefined,
      2,
      "task.read_thread",
    );

    expect(first.messages[0]?.text.length).toBe(2);
    expect(second.messages[0]?.text.length).toBe(2);
    expect(`${first.messages[0]?.text}${second.messages[0]?.text}`).toBe(text);
  }),
);

it.effect("rejects invalid, legacy, and stale transcript cursors", () =>
  Effect.gen(function* () {
    const messages = [transcriptMessage("message-1", "abcdef")];
    const invalid = yield* Effect.flip(
      __testing.paginateTranscript(messages, "not-base64-json", 3, "task.read_thread"),
    );
    expect(invalid.detail).toBe("The transcript cursor is invalid.");

    const legacy = Buffer.from("0", "utf8").toString("base64url");
    const incompatible = yield* Effect.flip(
      __testing.paginateTranscript(messages, legacy, 3, "task.read_thread"),
    );
    expect(incompatible.detail).toBe("The transcript cursor is invalid.");

    const first = yield* __testing.paginateTranscript(messages, undefined, 3, "task.read_thread");
    const stale = yield* Effect.flip(
      __testing.paginateTranscript(
        [transcriptMessage("replacement", "abcdef")],
        first.nextCursor ?? undefined,
        3,
        "task.read_thread",
      ),
    );
    expect(stale.detail).toBe("The transcript cursor is stale.");
  }),
);

it.effect("excludes streaming messages until they become stable", () =>
  Effect.gen(function* () {
    const messages = [
      transcriptMessage("message-1", "stable-one"),
      transcriptMessage("message-2", "partial", { streaming: true }),
      transcriptMessage("message-3", "stable-two"),
    ];

    const whileStreaming = yield* __testing.paginateTranscript(
      messages,
      undefined,
      100,
      "task.read_thread",
    );
    expect(whileStreaming.messages.map((message) => message.text)).toEqual([
      "stable-one",
      "stable-two",
    ]);
    expect(whileStreaming.nextCursor).toBeNull();
    expect(whileStreaming.truncated).toBe(false);

    const afterCompletion = yield* __testing.paginateTranscript(
      [
        messages[0]!,
        transcriptMessage("message-2", "partial-complete", {
          updatedAt: "2026-07-23T12:01:00.000Z",
        }),
        messages[2]!,
      ],
      undefined,
      100,
      "task.read_thread",
    );
    expect(afterCompletion.messages.map((message) => message.text)).toEqual([
      "stable-one",
      "partial-complete",
      "stable-two",
    ]);
  }),
);

it.effect("clamps transcript page limits to the documented bounds", () =>
  Effect.sync(() => {
    expect(__testing.transcriptLimit(undefined)).toBe(8_000);
    expect(__testing.transcriptLimit(0)).toBe(1);
    expect(__testing.transcriptLimit(1)).toBe(1);
    expect(__testing.transcriptLimit(16_000)).toBe(16_000);
    expect(__testing.transcriptLimit(16_001)).toBe(16_000);
  }),
);

it.effect("registers all coordination handlers with their mutation annotations", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tools = Object.fromEntries(
        server.tools.map(({ tool }) => [tool.name, tool.annotations]),
      );

      expect(Object.keys(tools)).toEqual(
        expect.arrayContaining([
          "task_create_pull_request",
          "task_send_message",
          "task_spawn_thread",
          "task_wait_for_threads",
        ]),
      );
      expect(tools.task_create_pull_request).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(tools.task_spawn_thread).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(tools.task_send_message).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(tools.task_wait_for_threads).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      });
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("capability-gates every coordination handler with a typed task error", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const requests = [
        {
          name: "task_spawn_thread" as const,
          arguments: { message: "Do not start this worker." },
        },
        {
          name: "task_send_message" as const,
          arguments: { threadId: childThreadId, message: "Do not send this." },
        },
        {
          name: "task_wait_for_threads" as const,
          arguments: { threadIds: [childThreadId], waitMs: 0 },
        },
        {
          name: "task_create_pull_request" as const,
          arguments: { threadId: childThreadId },
        },
      ];

      for (const request of requests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(new Set(["preview"])),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(true);
        expect(toolErrorText(result)).toContain("TaskToolError");
        expect(toolErrorText(result)).toContain(
          "This provider session does not have task orchestration access.",
        );
      }
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("rejects malformed coordination inputs before invoking handlers", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const malformed = [
        yield* server.callTool({
          name: "task_spawn_thread",
          arguments: { message: "   " },
        }),
        yield* server.callTool({
          name: "task_send_message",
          arguments: { threadId: childThreadId, message: "" },
        }),
        yield* server.callTool({
          name: "task_wait_for_threads",
          arguments: { threadIds: [], waitMs: 0 },
        }),
        yield* server.callTool({
          name: "task_create_pull_request",
          arguments: { threadId: "" },
        }),
      ];

      for (const result of malformed) {
        expect(result.isError).toBe(true);
      }
      expect(dispatchedCommands).toEqual([]);
    }).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(new Set(["task"])),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

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
  const gitManager = {
    runStackedAction: (input: import("@t3tools/contracts").GitRunStackedActionInput) =>
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
  } as unknown as GitManager.GitManager["Service"];

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
      makeCoordinationTestLayer(
        dispatchedCommands,
        readyQuery,
        {} as GitWorkflowService.GitWorkflowService["Service"],
        undefined,
        {} as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"],
        gitManager,
      ),
    ),
  );
});

it.effect("resolves HEAD to a stable branch before creating a repository worktree", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const createInputs: Array<import("@t3tools/contracts").VcsCreateWorktreeInput> = [];
  const gitWorkflow = {
    listRefs: () => currentBranchRefPage("main"),
    createWorktree: (input: import("@t3tools/contracts").VcsCreateWorktreeInput) =>
      Effect.sync(() => {
        createInputs.push(input);
        return {
          worktree: {
            refName: input.newRefName ?? input.refName,
            path: input.path ?? "/tmp/task/worktrees/repository-worker",
          },
        };
      }),
    removeWorktree: () => Effect.void,
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];
  const setupRunner = {
    runForThread: () => Effect.succeed({ status: "no-script" as const }),
  } as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            message: "Start from the current named branch.",
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
      expect(createInputs).toHaveLength(1);
      expect(createInputs[0]).toMatchObject({
        cwd: "/tmp/api",
        refName: "main",
        baseRefName: "main",
      });
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.agent.create",
        "thread.turn.start",
      ]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(
        dispatchedCommands,
        makeQuery([caller, child]),
        gitWorkflow,
        undefined,
        setupRunner,
      ),
    ),
  );
});

it.effect("rejects option-like and revision-expression repository base refs", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  let listCalls = 0;
  let createCalls = 0;
  const gitWorkflow = {
    listRefs: () =>
      Effect.sync(() => {
        listCalls += 1;
        return {
          refs: [],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 0,
        };
      }),
    createWorktree: () =>
      Effect.sync(() => {
        createCalls += 1;
        return {
          worktree: {
            refName: "unreachable",
            path: "/tmp/task/worktrees/unreachable",
          },
        };
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const optionLike = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            baseRef: "--detach",
            message: "Do not interpret this as a Git option.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const expression = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            baseRef: "main~1",
            message: "Do not persist a revision expression as branch metadata.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(optionLike.isError).toBe(true);
      expect(expression.isError).toBe(true);
      const optionContent = optionLike.content[0];
      const expressionContent = expression.content[0];
      expect(optionContent?.type === "text" ? optionContent.text : "").toContain(
        "must not start with '-'",
      );
      expect(expressionContent?.type === "text" ? expressionContent.text : "").toContain(
        "is not an existing local or remote branch",
      );
      expect(listCalls).toBe(1);
      expect(createCalls).toBe(0);
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands, query, gitWorkflow)));
});

it.effect("resolves an explicit branch from a later ref page before worktree creation", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const listInputs: Array<import("@t3tools/contracts").VcsListRefsInput> = [];
  const createInputs: Array<import("@t3tools/contracts").VcsCreateWorktreeInput> = [];
  const gitWorkflow = {
    listRefs: (input: import("@t3tools/contracts").VcsListRefsInput) =>
      Effect.sync(() => {
        listInputs.push(input);
        return input.cursor === undefined
          ? {
              refs: [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: 200,
              totalCount: 201,
            }
          : {
              refs: [
                {
                  name: "origin/release",
                  isRemote: true,
                  current: false,
                  isDefault: false,
                  worktreePath: null,
                },
              ],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 201,
            };
      }),
    createWorktree: (input: import("@t3tools/contracts").VcsCreateWorktreeInput) =>
      Effect.sync(() => {
        createInputs.push(input);
        return {
          worktree: {
            refName: input.newRefName ?? input.refName,
            path: input.path ?? "/tmp/task/worktrees/repository-worker",
          },
        };
      }),
    removeWorktree: () => Effect.void,
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];
  const setupRunner = {
    runForThread: () => Effect.succeed({ status: "no-script" as const }),
  } as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            baseRef: "origin/release",
            message: "Start from the stable remote branch.",
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
      expect(listInputs).toEqual([
        {
          cwd: "/tmp/api",
          query: "origin/release",
          cursor: undefined,
          includeMatchingRemoteRefs: true,
          limit: 200,
        },
        {
          cwd: "/tmp/api",
          query: "origin/release",
          cursor: 200,
          includeMatchingRemoteRefs: true,
          limit: 200,
        },
      ]);
      expect(createInputs[0]).toMatchObject({
        refName: "origin/release",
        baseRefName: "origin/release",
      });
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, query, gitWorkflow, undefined, setupRunner),
    ),
  );
});

it.effect("rejects unavailable spawn targets and task-root base refs before side effects", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const results = [
        yield* server.callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId: ProjectId.make("project-unapproved"),
            message: "Do not create this thread.",
          },
        }),
        yield* server.callTool({
          name: "task_spawn_thread",
          arguments: {
            baseRef: "main",
            message: "A task-root thread has no repository base.",
          },
        }),
      ];

      expect(results.every((result) => result.isError)).toBe(true);
      expect(toolErrorText(results[0]!)).toContain("is not approved for this task");
      expect(toolErrorText(results[1]!)).toContain(
        "baseRef is only valid when spawning a repository-bound task thread",
      );
      expect(dispatchedCommands).toEqual([]);
    }).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(new Set(["task"])),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("removes a created worktree when durable child creation is rejected", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const cleanupInputs: Array<
    Parameters<GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]>[0]
  > = [];
  const gitWorkflow = {
    listRefs: () => currentBranchRefPage(),
    createWorktree: () =>
      Effect.succeed(
        createdWorktreeResult("t3-task-create-rejected", "/tmp/task/worktrees/create-rejected"),
      ),
    cleanupCreatedWorktree: (
      input: Parameters<
        GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]
      >[0],
    ) =>
      Effect.sync(() => {
        cleanupInputs.push(input);
        return { branch: "deleted" as const };
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];
  const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
    command,
  ) => {
    dispatchedCommands.push(command);
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "simulated child-create rejection",
      }),
    );
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: { projectId, message: "This child creation will be rejected." },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.agent.create"]);
      expect(cleanupInputs).toEqual([
        {
          cwd: "/tmp/api",
          path: "/tmp/task/worktrees/create-rejected",
          createdBranch: createdWorktreeResult("t3-task-create-rejected", "/unused").createdBranch,
        },
      ]);
    }),
  ).pipe(
    Effect.provide(makeCoordinationTestLayer(dispatchedCommands, query, gitWorkflow, dispatch)),
  );
});

it.effect("sends a follow-up while the caller provider turn is running", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const idleChild = thread(
    childThreadId,
    { kind: "agent" },
    { sessionStatus: "ready", latestTurnState: "completed" },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_send_message",
          arguments: {
            threadId: childThreadId,
            message: "Please address the review feedback.",
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
      expect(dispatchedCommands).toHaveLength(1);
      const command = dispatchedCommands[0];
      expect(command?.type).toBe("thread.turn.start");
      if (command?.type === "thread.turn.start") {
        expect(command.threadId).toBe(childThreadId);
        expect(command.message.text).toBe("Please address the review feedback.");
      }
    }),
  ).pipe(
    Effect.provide(makeCoordinationTestLayer(dispatchedCommands, makeQuery([caller, idleChild]))),
  );
});

it.effect("rejects follow-ups to user-owned, working, and cross-task threads", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const outsideThreadId = ThreadId.make("thread-outside-task");
  const outsideThread = {
    ...thread(
      outsideThreadId,
      { kind: "agent" },
      { sessionStatus: "ready", latestTurnState: "completed" },
    ),
    taskContext: {
      taskId: TaskId.make("task-other"),
      createdBy: {
        kind: "agent" as const,
        threadId: callerThreadId,
        turnId: TurnId.make("turn-parent"),
      },
    },
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const results = [
        yield* server.callTool({
          name: "task_send_message",
          arguments: { threadId: callerThreadId, message: "Do not message a user thread." },
        }),
        yield* server.callTool({
          name: "task_send_message",
          arguments: { threadId: childThreadId, message: "Do not overlap its active turn." },
        }),
        yield* server.callTool({
          name: "task_send_message",
          arguments: { threadId: outsideThreadId, message: "Do not cross task scope." },
        }),
      ];

      expect(results.every((result) => result.isError)).toBe(true);
      expect(toolErrorText(results[0]!)).toContain(
        "Follow-up messages may target only agent-created threads.",
      );
      expect(toolErrorText(results[1]!)).toContain("is still working");
      expect(toolErrorText(results[2]!)).toContain("is outside the current task");
      expect(dispatchedCommands).toEqual([]);
    }).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(new Set(["task"])),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, makeQuery([caller, child, outsideThread])),
    ),
  );
});

it.effect("rejects coordination mutations invoked from an agent-created caller", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: { message: "Agent-created callers cannot recursively coordinate." },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation(new Set(["task"])),
            threadId: childThreadId,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(toolErrorText(result)).toContain(
        "Task tools require a user-created thread in an active task.",
      );
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("bounds waits, refreshes status, and remains readable after the caller stops", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const stoppedCaller = thread(callerThreadId, { kind: "user" }, { sessionStatus: "stopped" });
  const readyChild = thread(
    childThreadId,
    { kind: "agent" },
    { sessionStatus: "ready", latestTurnState: "completed" },
  );
  let refreshed = false;
  const projectionQuery = makeQuery(() => [stoppedCaller, refreshed ? readyChild : child]);

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const waitFiber = yield* server
        .callTool({
          name: "task_wait_for_threads",
          arguments: { threadIds: [childThreadId], waitMs: 50_000 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkScoped,
        );

      yield* Effect.yieldNow;
      refreshed = true;
      yield* TestClock.adjust("9999 millis");
      expect(waitFiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      const result = yield* Fiber.join(waitFiber);

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        threads: [{ threadId: childThreadId, status: "ready" }],
        timedOut: false,
      });
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands, projectionQuery)));
});

it.effect("reports a zero-wait working snapshot as timed out", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_wait_for_threads",
          arguments: { threadIds: [childThreadId], waitMs: 0 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        threads: [{ threadId: childThreadId, status: "working" }],
        timedOut: true,
      });
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands)));
});

it.effect("revalidates waited thread membership after the bounded wait", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const baseQuery = makeQuery([caller, child]);
  let snapshotCalls = 0;
  const projectionQuery = {
    ...baseQuery,
    getShellSnapshot: () =>
      baseQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          threads: ++snapshotCalls === 1 ? snapshot.threads : [caller],
        })),
      ),
  } as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_wait_for_threads",
          arguments: { threadIds: [childThreadId], waitMs: 0 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(toolErrorText(result)).toContain("is outside the current task");
      expect(snapshotCalls).toBe(2);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands, projectionQuery)));
});

it.effect("uses the shared mutation guard when the caller session is ready", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const readyCaller = thread(callerThreadId, { kind: "user" }, { sessionStatus: "ready" });
  const idleChild = thread(
    childThreadId,
    { kind: "agent" },
    { sessionStatus: "ready", latestTurnState: "completed" },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const spawnResult = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: { message: "Start another worker." },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const sendResult = yield* server
        .callTool({
          name: "task_send_message",
          arguments: { threadId: childThreadId, message: "Continue." },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      for (const result of [spawnResult, sendResult]) {
        expect(result.isError).toBe(true);
        const content = result.content[0];
        expect(content?.type === "text" ? content.text : "").toContain(
          "The calling thread must have a running provider session with an active turn.",
        );
      }
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, makeQuery([readyCaller, idleChild])),
    ),
  );
});

it.effect("rejects mutations when a running caller has no active turn id", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const callerWithoutTurn = thread(
    callerThreadId,
    { kind: "user" },
    { sessionStatus: "running", activeTurnId: null },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: { message: "Do not spawn without a projected active turn." },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(toolErrorText(result)).toContain(
        "The calling thread must have a running provider session with an active turn.",
      );
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, makeQuery([callerWithoutTurn, child])),
    ),
  );
});

it.effect("rejects coordination reads after the task leaves active status", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const baseQuery = makeQuery([caller, child]);
  const projectionQuery = {
    ...baseQuery,
    getShellSnapshot: () =>
      baseQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          tasks: snapshot.tasks?.map((task) => ({
            ...task,
            status: "completing" as const,
          })),
        })),
      ),
  } as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_wait_for_threads",
          arguments: { threadIds: [childThreadId], waitMs: 0 },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(toolErrorText(result)).toContain(`Task '${taskId}' is not active.`);
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(Effect.provide(makeCoordinationTestLayer(dispatchedCommands, projectionQuery)));
});

it.effect("cleans up the worktree when the caller turn changes before child creation", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const cleanupInputs: Array<
    Parameters<GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]>[0]
  > = [];
  let currentCaller = caller;
  const projectionQuery = makeQuery(() => [currentCaller, child]);
  const gitWorkflow = {
    listRefs: () => currentBranchRefPage(),
    createWorktree: () =>
      Effect.sync(() => {
        currentCaller = thread(
          callerThreadId,
          { kind: "user" },
          { activeTurnId: TurnId.make("turn-caller-replacement") },
        );
        return createdWorktreeResult("t3-task-test", "/tmp/task/worktrees/replaced-turn");
      }),
    cleanupCreatedWorktree: (
      input: Parameters<
        GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]
      >[0],
    ) =>
      Effect.sync(() => {
        cleanupInputs.push(input);
        return { branch: "deleted" as const };
      }),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            message: "Start a repository worker.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type === "text" ? content.text : "").toContain(
        "The calling provider turn changed before the task thread could be created.",
      );
      expect(dispatchedCommands).toEqual([]);
      expect(cleanupInputs).toEqual([
        {
          cwd: "/tmp/api",
          path: "/tmp/task/worktrees/replaced-turn",
          createdBranch: createdWorktreeResult("t3-task-test", "/unused").createdBranch,
        },
      ]);
    }),
  ).pipe(
    Effect.provide(makeCoordinationTestLayer(dispatchedCommands, projectionQuery, gitWorkflow)),
  );
});

it.effect("cleans up after interruption following worktree creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const afterWorktree = yield* Deferred.make<void>();
      const refreshInterrupted = yield* Deferred.make<void>();
      const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
      const cleanupInputs: Array<
        Parameters<GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]>[0]
      > = [];
      const baseQuery = makeQuery([caller, child]);
      let shellSnapshotCalls = 0;
      const projectionQuery = {
        ...baseQuery,
        getShellSnapshot: () =>
          Effect.gen(function* () {
            shellSnapshotCalls += 1;
            if (shellSnapshotCalls === 2) {
              yield* Deferred.succeed(afterWorktree, undefined);
              yield* Deferred.await(refreshInterrupted).pipe(
                Effect.onInterrupt(() =>
                  Deferred.succeed(refreshInterrupted, undefined).pipe(Effect.asVoid),
                ),
              );
            }
            return yield* baseQuery.getShellSnapshot();
          }),
      } as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
      const gitWorkflow = {
        listRefs: () => currentBranchRefPage(),
        createWorktree: () =>
          Effect.succeed(
            createdWorktreeResult(
              "t3-task-interrupted-after-worktree",
              "/tmp/task/worktrees/interrupted-after-worktree",
            ),
          ),
        cleanupCreatedWorktree: (
          input: Parameters<
            GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]
          >[0],
        ) =>
          Effect.sync(() => {
            cleanupInputs.push(input);
            return { branch: "deleted" as const };
          }),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"];
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const spawnFiber = yield* server
          .callTool({
            name: "task_spawn_thread",
            arguments: {
              projectId,
              message: "Interrupt after the worktree commit point.",
            },
          })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(new Set(["task"])),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.forkScoped,
          );

        yield* Deferred.await(afterWorktree);
        const interruptFiber = yield* Fiber.interrupt(spawnFiber).pipe(Effect.forkScoped);
        yield* Deferred.await(refreshInterrupted);
        yield* Fiber.join(interruptFiber);
        const interruptedExit = yield* Fiber.await(spawnFiber);

        expect(Exit.isFailure(interruptedExit)).toBe(true);
        if (Exit.isFailure(interruptedExit)) {
          expect(Cause.hasInterrupts(interruptedExit.cause)).toBe(true);
        }
        expect(dispatchedCommands).toEqual([]);
        expect(cleanupInputs).toEqual([
          {
            cwd: "/tmp/api",
            path: "/tmp/task/worktrees/interrupted-after-worktree",
            createdBranch: createdWorktreeResult("t3-task-interrupted-after-worktree", "/unused")
              .createdBranch,
          },
        ]);
      }).pipe(
        Effect.provide(makeCoordinationTestLayer(dispatchedCommands, projectionQuery, gitWorkflow)),
      );
    }),
  ),
);

it.effect("cleans up after interruption following durable thread dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const afterThreadDispatch = yield* Deferred.make<void>();
      const setupInterrupted = yield* Deferred.make<void>();
      const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
      const cleanupInputs: Array<
        Parameters<GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]>[0]
      > = [];
      const gitWorkflow = {
        listRefs: () => currentBranchRefPage(),
        createWorktree: () =>
          Effect.succeed(
            createdWorktreeResult(
              "t3-task-interrupted-after-dispatch",
              "/tmp/task/worktrees/interrupted-after-dispatch",
            ),
          ),
        cleanupCreatedWorktree: (
          input: Parameters<
            GitWorkflowService.GitWorkflowService["Service"]["cleanupCreatedWorktree"]
          >[0],
        ) =>
          Effect.sync(() => {
            cleanupInputs.push(input);
            return { branch: "deleted" as const };
          }),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"];
      const setupRunner = {
        runForThread: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(afterThreadDispatch, undefined);
            yield* Deferred.await(setupInterrupted).pipe(
              Effect.onInterrupt(() =>
                Deferred.succeed(setupInterrupted, undefined).pipe(Effect.asVoid),
              ),
            );
            return { status: "no-script" as const };
          }),
      } as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const spawnFiber = yield* server
          .callTool({
            name: "task_spawn_thread",
            arguments: {
              projectId,
              message: "Interrupt after the durable thread commit point.",
            },
          })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(new Set(["task"])),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.forkScoped,
          );

        yield* Deferred.await(afterThreadDispatch);
        const interruptFiber = yield* Fiber.interrupt(spawnFiber).pipe(Effect.forkScoped);
        yield* Deferred.await(setupInterrupted);
        yield* Fiber.join(interruptFiber);
        const interruptedExit = yield* Fiber.await(spawnFiber);

        expect(Exit.isFailure(interruptedExit)).toBe(true);
        if (Exit.isFailure(interruptedExit)) {
          expect(Cause.hasInterrupts(interruptedExit.cause)).toBe(true);
        }
        expect(cleanupInputs).toEqual([
          {
            cwd: "/tmp/api",
            path: "/tmp/task/worktrees/interrupted-after-dispatch",
            createdBranch: createdWorktreeResult("t3-task-interrupted-after-dispatch", "/unused")
              .createdBranch,
          },
        ]);
        expect(dispatchedCommands.map((command) => command.type)).toEqual([
          "thread.agent.create",
          "thread.delete",
        ]);
      }).pipe(
        Effect.provide(
          makeCoordinationTestLayer(
            dispatchedCommands,
            makeQuery([caller, child]),
            gitWorkflow,
            undefined,
            setupRunner,
          ),
        ),
      );
    }),
  ),
);

it.effect("retains the durable thread when its worktree cleanup fails", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const gitWorkflow = {
    listRefs: () => currentBranchRefPage(),
    createWorktree: () =>
      Effect.succeed(
        createdWorktreeResult("t3-task-retained-owner", "/tmp/task/worktrees/retained-owner"),
      ),
    cleanupCreatedWorktree: () => Effect.die(new Error("simulated cleanup failure")),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"];
  const setupRunner = {
    runForThread: () => Effect.succeed({ status: "no-script" as const }),
  } as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
    command,
  ) => {
    dispatchedCommands.push(command);
    return command.type === "thread.turn.start"
      ? Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "simulated turn-start failure",
          }),
        )
      : Effect.succeed({ sequence: dispatchedCommands.length });
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: {
            projectId,
            message: "Retain my durable owner if cleanup fails.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.agent.create",
        "thread.turn.start",
      ]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(
        dispatchedCommands,
        makeQuery([caller, child]),
        gitWorkflow,
        dispatch,
        setupRunner,
      ),
    ),
  );
});

it.effect("rejects follow-up messages after the caller session stops", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const stoppedCaller = thread(callerThreadId, { kind: "user" }, { sessionStatus: "stopped" });
  const idleChild = thread(
    childThreadId,
    { kind: "agent" },
    { sessionStatus: "ready", latestTurnState: "completed" },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_send_message",
          arguments: {
            threadId: childThreadId,
            message: "This credential must no longer mutate the task.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(content?.type === "text" ? content.text : "").toContain(
        "The calling thread must have a running provider session with an active turn.",
      );
      expect(dispatchedCommands).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(dispatchedCommands, makeQuery([stoppedCaller, idleChild])),
    ),
  );
});

it.effect("surfaces an authoritative task completion race during spawned initial turn", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
    command,
  ) => {
    dispatchedCommands.push(command);
    return command.type === "thread.turn.start"
      ? Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Task '${taskId}' is 'completing' and cannot handle '${command.type}'.`,
          }),
        )
      : Effect.succeed({ sequence: dispatchedCommands.length });
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_spawn_thread",
          arguments: { message: "Start a worker before task completion." },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(dispatchedCommands.map((command) => command.type)).toEqual([
        "thread.agent.create",
        "thread.turn.start",
        "thread.delete",
      ]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(
        dispatchedCommands,
        makeQuery([caller, child]),
        {} as GitWorkflowService.GitWorkflowService["Service"],
        dispatch,
      ),
    ),
  );
});

it.effect("surfaces an authoritative target-running race during follow-up dispatch", () => {
  const dispatchedCommands: Array<import("@t3tools/contracts").OrchestrationCommand> = [];
  const idleChild = thread(
    childThreadId,
    { kind: "agent" },
    { sessionStatus: "ready", latestTurnState: "completed" },
  );
  const dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"] = (
    command,
  ) => {
    dispatchedCommands.push(command);
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Task thread '${childThreadId}' already has an active or starting turn.`,
      }),
    );
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "task_send_message",
          arguments: {
            threadId: childThreadId,
            message: "This raced with a newly running turn.",
          },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(new Set(["task"])),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.turn.start"]);
    }),
  ).pipe(
    Effect.provide(
      makeCoordinationTestLayer(
        dispatchedCommands,
        makeQuery([caller, idleChild]),
        {} as GitWorkflowService.GitWorkflowService["Service"],
        dispatch,
      ),
    ),
  );
});

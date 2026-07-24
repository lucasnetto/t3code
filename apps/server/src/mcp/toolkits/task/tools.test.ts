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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointRefUnavailableError } from "../../../checkpointing/Errors.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  } = {},
): OrchestrationThreadShell => ({
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
  archivedAt: options.archivedAt ?? null,
  settledOverride: null,
  settledAt: null,
  session: null,
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
});

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
        },
      ],
      threads: [caller, child, archived, crossTask],
      updatedAt: createdAt,
    }),
} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

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
            status: "idle",
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
        status: "idle",
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
    expect(__testing.statusForThread(caller)).toBe("idle");
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
        session: {
          threadId: callerThreadId,
          status: "error",
          providerName: "codex",
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

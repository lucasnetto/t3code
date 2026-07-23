import type {
  OrchestrationProjectShell,
  OrchestrationTask,
  OrchestrationThreadShell,
  TaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TaskToolError, TaskToolkit } from "./tools.ts";

const MAX_TRANSCRIPT_CHARS = 16_000;
const DEFAULT_TRANSCRIPT_CHARS = 8_000;
const MAX_DIFF_CHARS = 32_000;

export interface TaskToolScope {
  readonly task: OrchestrationTask;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

export const failTaskTool = (operation: string, detail: string) =>
  new TaskToolError({
    operation,
    detail,
  });

export const requireTaskScope = Effect.fn("TaskToolkit.requireScope")(function* (
  operation: string,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("task")) {
    return yield* failTaskTool(
      operation,
      "This provider session does not have task orchestration access.",
    );
  }
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const caller = yield* query
    .getThreadShellById(invocation.threadId)
    .pipe(
      Effect.mapError(() => failTaskTool(operation, "Could not resolve the calling task thread.")),
    );
  if (Option.isNone(caller) || caller.value.taskContext?.createdBy.kind !== "user") {
    return yield* failTaskTool(
      operation,
      "Task tools require a user-created thread in an active task.",
    );
  }
  const snapshot = yield* query
    .getShellSnapshot()
    .pipe(Effect.mapError(() => failTaskTool(operation, "Could not load the current task.")));
  const taskId = caller.value.taskContext.taskId;
  const task = snapshot.tasks?.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "active") {
    return yield* failTaskTool(operation, `Task '${taskId}' is not active.`);
  }
  return {
    task,
    projects: snapshot.projects,
    threads: snapshot.threads,
  } satisfies TaskToolScope;
});

export function statusForThread(
  thread: OrchestrationThreadShell,
): "idle" | "working" | "approval" | "input" | "failed" | "ready" {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.latestTurn?.state === "running") return "working";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "failed";
  if (thread.latestTurn?.state === "completed") return "ready";
  return "idle";
}

export function taskThreadSummary(thread: OrchestrationThreadShell) {
  const createdBy = thread.taskContext?.createdBy;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    origin:
      createdBy?.kind === "agent"
        ? { kind: "agent" as const, threadId: createdBy.threadId }
        : { kind: "user" as const },
    status: statusForThread(thread),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    updatedAt: thread.updatedAt,
  };
}

export function requireTaskThread(
  scope: TaskToolScope,
  threadId: ThreadId,
  operation: string,
): Effect.Effect<OrchestrationThreadShell, TaskToolError> {
  const thread = scope.threads.find(
    (candidate) => candidate.id === threadId && candidate.taskContext?.taskId === scope.task.id,
  );
  return thread
    ? Effect.succeed(thread)
    : Effect.fail(failTaskTool(operation, `Thread '${threadId}' is outside the current task.`));
}

function decodeCursor(
  cursor: string | undefined,
  operation: string,
): Effect.Effect<number, TaskToolError> {
  if (!cursor) return Effect.succeed(0);
  return Effect.try({
    try: () => {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const index = Number.parseInt(decoded, 10);
      if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid cursor");
      return index;
    },
    catch: () => failTaskTool(operation, "The transcript cursor is invalid."),
  });
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index), "utf8").toString("base64url");
}

const handlers = {
  task_list_repositories: () =>
    Effect.gen(function* () {
      const scope = yield* requireTaskScope("task.list_repositories");
      const approved = new Set(scope.task.approvedProjectIds);
      return {
        taskId: scope.task.id,
        repositories: scope.projects
          .filter((project) => approved.has(project.id))
          .map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
      };
    }),
  task_list_threads: () =>
    Effect.gen(function* () {
      const scope = yield* requireTaskScope("task.list_threads");
      return {
        taskId: scope.task.id,
        threads: scope.threads
          .filter((thread) => thread.taskContext?.taskId === scope.task.id)
          .map(taskThreadSummary),
      };
    }),
  task_get_thread_status: ({ threadId }) =>
    Effect.gen(function* () {
      const scope = yield* requireTaskScope("task.get_thread_status");
      return taskThreadSummary(yield* requireTaskThread(scope, threadId, "task.get_thread_status"));
    }),
  task_read_thread: ({ threadId, cursor, maxChars }) =>
    Effect.gen(function* () {
      const operation = "task.read_thread";
      const scope = yield* requireTaskScope(operation);
      yield* requireTaskThread(scope, threadId, operation);
      const offset = yield* decodeCursor(cursor, operation);
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const detail = yield* query
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError(() => failTaskTool(operation, `Could not read thread '${threadId}'.`)),
        );
      if (Option.isNone(detail)) {
        return yield* failTaskTool(operation, `Thread '${threadId}' was not found.`);
      }
      const limit = Math.min(
        Math.max(maxChars ?? DEFAULT_TRANSCRIPT_CHARS, 1),
        MAX_TRANSCRIPT_CHARS,
      );
      const messages = [];
      let used = 0;
      let nextIndex = offset;
      while (nextIndex < detail.value.messages.length) {
        const message = detail.value.messages[nextIndex]!;
        if (messages.length > 0 && used + message.text.length > limit) break;
        messages.push({
          role: message.role,
          text: message.text.slice(0, Math.max(limit - used, 0)),
          createdAt: message.createdAt,
        });
        used += message.text.length;
        nextIndex += 1;
        if (used >= limit) break;
      }
      const truncated = nextIndex < detail.value.messages.length;
      return {
        threadId,
        messages,
        nextCursor: truncated ? encodeCursor(nextIndex) : null,
        truncated,
      };
    }),
  task_get_thread_diff: ({ threadId, fromTurn, toTurn }) =>
    Effect.gen(function* () {
      const operation = "task.get_thread_diff";
      const scope = yield* requireTaskScope(operation);
      const thread = yield* requireTaskThread(scope, threadId, operation);
      if (!thread.worktreePath) {
        return yield* failTaskTool(operation, `Thread '${threadId}' has no repository checkout.`);
      }
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const detail = yield* query
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError(() => failTaskTool(operation, `Could not inspect thread '${threadId}'.`)),
        );
      if (Option.isNone(detail)) {
        return yield* failTaskTool(operation, `Thread '${threadId}' was not found.`);
      }
      const lastTurn = detail.value.checkpoints.reduce(
        (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
        0,
      );
      const resolvedFrom = fromTurn ?? 0;
      const resolvedTo = toTurn ?? lastTurn;
      if (resolvedTo === 0) {
        return yield* failTaskTool(
          operation,
          `Thread '${threadId}' has no completed Git checkpoint.`,
        );
      }
      const checkpointDiff = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* checkpointDiff
        .getTurnDiff({
          threadId,
          fromTurnCount: resolvedFrom,
          toTurnCount: resolvedTo,
          ignoreWhitespace: true,
        })
        .pipe(
          Effect.mapError(() =>
            failTaskTool(operation, `Could not compute the diff for '${threadId}'.`),
          ),
        );
      return {
        threadId,
        fromTurn: result.fromTurnCount,
        toTurn: result.toTurnCount,
        diff: result.diff.slice(0, MAX_DIFF_CHARS),
        truncated: result.diff.length > MAX_DIFF_CHARS,
      };
    }),
} satisfies Parameters<typeof TaskToolkit.toLayer>[0];

export const TaskToolkitHandlersLive = TaskToolkit.toLayer(handlers);

export const __testing = {
  statusForThread,
  encodeCursor,
  decodeCursor,
};

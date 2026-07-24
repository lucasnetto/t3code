import type {
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationTask,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { IsoDateTime, MessageId, NonNegativeInt, TaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  TaskThreadDiffError,
  type TaskThreadDiffErrorReason,
  TaskToolError,
  TaskToolkit,
} from "./tools.ts";

const MAX_TRANSCRIPT_CHARS = 16_000;
const DEFAULT_TRANSCRIPT_CHARS = 8_000;
const MAX_DIFF_CHARS = 32_000;
const MAX_LIST_ITEMS = 100;
const DEFAULT_LIST_ITEMS = 50;

const ListCollection = Schema.Literals(["repositories", "threads"]);
type ListCollection = typeof ListCollection.Type;

const ListCursor = Schema.Struct({
  v: Schema.Literal(1),
  taskId: TaskId,
  collection: ListCollection,
  anchorId: Schema.NonEmptyString,
  anchorIndex: NonNegativeInt,
});
interface ListCursor extends Schema.Schema.Type<typeof ListCursor> {}

const ListCursorJson = Schema.fromJsonString(ListCursor);
const decodeListCursorJson = Schema.decodeUnknownEffect(ListCursorJson);
const encodeListCursorJson = Schema.encodeSync(ListCursorJson);

const TranscriptCursor = Schema.Struct({
  v: Schema.Literal(1),
  messageId: MessageId,
  messageIndex: NonNegativeInt,
  messageUpdatedAt: IsoDateTime,
  characterOffset: NonNegativeInt,
});
interface TranscriptCursor extends Schema.Schema.Type<typeof TranscriptCursor> {}

const TranscriptCursorJson = Schema.fromJsonString(TranscriptCursor);
const decodeTranscriptCursorJson = Schema.decodeUnknownEffect(TranscriptCursorJson);
const encodeTranscriptCursorJson = Schema.encodeSync(TranscriptCursorJson);

interface TranscriptPage {
  readonly messages: ReadonlyArray<{
    readonly role: OrchestrationMessage["role"];
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

interface ListPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export interface TaskToolScope {
  readonly task: OrchestrationTask;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

export interface ActiveTaskMutationScope extends TaskToolScope {
  readonly caller: OrchestrationThreadShell;
  readonly activeTurnId: TurnId;
}

export const failTaskTool = (
  operation: string,
  detail: string,
  reason?: "unavailable" | "conflict",
) =>
  new TaskToolError({
    operation,
    detail,
    ...(reason ? { reason } : {}),
  });

const diffFail = (reason: TaskThreadDiffErrorReason, detail: string) =>
  new TaskThreadDiffError({
    operation: "task.get_thread_diff",
    reason,
    detail,
  });

function classifyCheckpointDiffError(
  threadId: ThreadId,
  error: CheckpointServiceError,
): TaskThreadDiffError {
  switch (error._tag) {
    case "CheckpointWorkspacePathMissingError":
    case "CheckpointWorkspaceUnavailableError":
      return diffFail(
        "checkout-unavailable",
        `Thread '${threadId}' has no available Git checkout.`,
      );
    case "CheckpointTurnRangeUnavailableError":
      return diffFail(
        "invalid-range",
        `The requested turn range is unavailable for '${threadId}'.`,
      );
    case "CheckpointRefUnavailableError":
      return diffFail(
        "checkpoint-unavailable",
        `A requested Git checkpoint is unavailable for '${threadId}'.`,
      );
    default:
      return diffFail("diff-failed", `Could not compute the diff for '${threadId}'.`);
  }
}

function isActiveTaskThread(
  thread: OrchestrationThreadShell,
  taskId: OrchestrationTask["id"],
): boolean {
  return thread.archivedAt === null && thread.taskContext?.taskId === taskId;
}

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
  if (
    Option.isNone(caller) ||
    caller.value.archivedAt !== null ||
    caller.value.taskContext?.createdBy.kind !== "user"
  ) {
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
    threads: snapshot.threads.filter((thread) => isActiveTaskThread(thread, task.id)),
  } satisfies TaskToolScope;
});

export const requireActiveTaskMutationScope = Effect.fn("TaskToolkit.requireActiveMutationScope")(
  function* (operation: string) {
    const scope = yield* requireTaskScope(operation);
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const caller = yield* requireTaskThread(scope, invocation.threadId, operation);
    const activeTurnId = caller.session?.activeTurnId;
    if (
      caller.session?.status !== "running" ||
      activeTurnId === null ||
      activeTurnId === undefined
    ) {
      return yield* failTaskTool(
        operation,
        "The calling thread must have a running provider session with an active turn.",
      );
    }
    return {
      ...scope,
      caller,
      activeTurnId,
    } satisfies ActiveTaskMutationScope;
  },
);

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

export function taskThreadSummary(thread: OrchestrationThreadShell, task: OrchestrationTask) {
  const createdBy = thread.taskContext?.createdBy;
  return {
    threadId: thread.id,
    target:
      thread.projectId === task.workspaceProjectId
        ? { kind: "task-root" as const }
        : { kind: "repository" as const, projectId: thread.projectId },
    title: thread.title,
    origin:
      createdBy?.kind === "agent"
        ? {
            kind: "agent" as const,
            threadId: createdBy.threadId,
            turnId: createdBy.turnId,
          }
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
  const thread = scope.threads.find((candidate) => candidate.id === threadId);
  return thread
    ? Effect.succeed(thread)
    : Effect.fail(failTaskTool(operation, `Thread '${threadId}' is outside the current task.`));
}

function decodeCursor(
  cursor: string | undefined,
  operation: string,
): Effect.Effect<Option.Option<TranscriptCursor>, TaskToolError> {
  if (!cursor) return Effect.succeed(Option.none());
  return Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: () => failTaskTool(operation, "The transcript cursor is invalid."),
  }).pipe(
    Effect.flatMap(decodeTranscriptCursorJson),
    Effect.map(Option.some),
    Effect.mapError(() => failTaskTool(operation, "The transcript cursor is invalid.")),
  );
}

function encodeCursor(cursor: TranscriptCursor): string {
  return Buffer.from(encodeTranscriptCursorJson(cursor), "utf8").toString("base64url");
}

function cursorForMessage(
  message: OrchestrationMessage,
  messageIndex: number,
  characterOffset: number,
) {
  return encodeCursor({
    v: 1,
    messageId: message.id,
    messageIndex,
    messageUpdatedAt: message.updatedAt,
    characterOffset,
  });
}

function nextStableMessageIndex(
  messages: ReadonlyArray<OrchestrationMessage>,
  startIndex: number,
): number | undefined {
  for (let index = startIndex; index < messages.length; index += 1) {
    if (!messages[index]?.streaming) return index;
  }
  return undefined;
}

const paginateTranscript = Effect.fn("TaskToolkit.paginateTranscript")(function* (
  messages: ReadonlyArray<OrchestrationMessage>,
  cursor: string | undefined,
  limit: number,
  operation: string,
): Effect.fn.Return<TranscriptPage, TaskToolError> {
  const decodedCursor = yield* decodeCursor(cursor, operation);
  let messageIndex = Option.isSome(decodedCursor)
    ? decodedCursor.value.messageIndex
    : (nextStableMessageIndex(messages, 0) ?? messages.length);
  let characterOffset = Option.isSome(decodedCursor) ? decodedCursor.value.characterOffset : 0;

  if (Option.isSome(decodedCursor)) {
    const cursorMessage = messages[decodedCursor.value.messageIndex];
    if (
      !cursorMessage ||
      cursorMessage.streaming ||
      cursorMessage.id !== decodedCursor.value.messageId ||
      cursorMessage.updatedAt !== decodedCursor.value.messageUpdatedAt ||
      decodedCursor.value.characterOffset > cursorMessage.text.length
    ) {
      return yield* failTaskTool(operation, "The transcript cursor is stale.");
    }
  }

  const page: Array<TranscriptPage["messages"][number]> = [];
  let used = 0;

  while (messageIndex < messages.length && used < limit) {
    const message = messages[messageIndex];
    if (!message || message.streaming) {
      messageIndex += 1;
      characterOffset = 0;
      continue;
    }

    const available = limit - used;
    const text = message.text.slice(characterOffset, characterOffset + available);
    page.push({
      role: message.role,
      text,
      createdAt: message.createdAt,
    });
    used += text.length;
    characterOffset += text.length;

    if (characterOffset < message.text.length) {
      return {
        messages: page,
        nextCursor: cursorForMessage(message, messageIndex, characterOffset),
        truncated: true,
      };
    }

    const nextIndex = nextStableMessageIndex(messages, messageIndex + 1);
    if (nextIndex === undefined) {
      return {
        messages: page,
        nextCursor: null,
        truncated: false,
      };
    }
    messageIndex = nextIndex;
    characterOffset = 0;
  }

  const nextMessage = messages[messageIndex];
  return {
    messages: page,
    nextCursor:
      nextMessage && !nextMessage.streaming
        ? cursorForMessage(nextMessage, messageIndex, characterOffset)
        : null,
    truncated: nextMessage !== undefined && !nextMessage.streaming,
  };
});

function transcriptLimit(maxChars: number | undefined): number {
  return Math.min(Math.max(maxChars ?? DEFAULT_TRANSCRIPT_CHARS, 1), MAX_TRANSCRIPT_CHARS);
}

function listLimit(maxItems: number | undefined): number {
  return Math.min(Math.max(maxItems ?? DEFAULT_LIST_ITEMS, 1), MAX_LIST_ITEMS);
}

function decodeListCursor(
  cursor: string | undefined,
  operation: string,
): Effect.Effect<Option.Option<ListCursor>, TaskToolError> {
  if (!cursor) return Effect.succeed(Option.none());
  return Effect.try({
    try: () => Buffer.from(cursor, "base64url").toString("utf8"),
    catch: () => failTaskTool(operation, "The list cursor is invalid."),
  }).pipe(
    Effect.flatMap(decodeListCursorJson),
    Effect.map(Option.some),
    Effect.mapError(() => failTaskTool(operation, "The list cursor is invalid.")),
  );
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(encodeListCursorJson(cursor), "utf8").toString("base64url");
}

const paginateList = Effect.fn("TaskToolkit.paginateList")(function* <T>(
  items: ReadonlyArray<T>,
  cursor: string | undefined,
  limit: number,
  taskId: TaskId,
  collection: ListCollection,
  itemId: (item: T) => string,
  operation: string,
): Effect.fn.Return<ListPage<T>, TaskToolError> {
  const decodedCursor = yield* decodeListCursor(cursor, operation);
  let startIndex = 0;

  if (Option.isSome(decodedCursor)) {
    const decoded = decodedCursor.value;
    if (decoded.taskId !== taskId || decoded.collection !== collection) {
      return yield* failTaskTool(operation, "The list cursor is invalid.");
    }
    const anchor = items[decoded.anchorIndex];
    if (!anchor || itemId(anchor) !== decoded.anchorId) {
      return yield* failTaskTool(operation, "The list cursor is stale.");
    }
    startIndex = decoded.anchorIndex + 1;
  }

  const page = items.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + page.length;
  if (nextIndex >= items.length) {
    return { items: page, nextCursor: null };
  }

  const anchor = page.at(-1);
  if (!anchor) {
    return yield* failTaskTool(operation, "The list cursor did not advance.");
  }
  return {
    items: page,
    nextCursor: encodeListCursor({
      v: 1,
      taskId,
      collection,
      anchorId: itemId(anchor),
      anchorIndex: nextIndex - 1,
    }),
  };
});

const handlers = {
  task_list_repositories: ({ cursor, maxItems }) =>
    Effect.gen(function* () {
      const operation = "task.list_repositories";
      const scope = yield* requireTaskScope(operation);
      const approved = new Set(scope.task.approvedProjectIds);
      const page = yield* paginateList(
        scope.projects.filter((project) => approved.has(project.id)),
        cursor,
        listLimit(maxItems),
        scope.task.id,
        "repositories",
        (project) => project.id,
        operation,
      );
      return {
        taskId: scope.task.id,
        repositories: page.items.map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
        nextCursor: page.nextCursor,
      };
    }),
  task_list_threads: ({ cursor, maxItems }) =>
    Effect.gen(function* () {
      const operation = "task.list_threads";
      const scope = yield* requireTaskScope(operation);
      const page = yield* paginateList(
        scope.threads,
        cursor,
        listLimit(maxItems),
        scope.task.id,
        "threads",
        (thread) => thread.id,
        operation,
      );
      return {
        taskId: scope.task.id,
        threads: page.items.map((thread) => taskThreadSummary(thread, scope.task)),
        nextCursor: page.nextCursor,
      };
    }),
  task_get_thread_status: ({ threadId }) =>
    Effect.gen(function* () {
      const scope = yield* requireTaskScope("task.get_thread_status");
      return taskThreadSummary(
        yield* requireTaskThread(scope, threadId, "task.get_thread_status"),
        scope.task,
      );
    }),
  task_read_thread: ({ threadId, cursor, maxChars }) =>
    Effect.gen(function* () {
      const operation = "task.read_thread";
      const scope = yield* requireTaskScope(operation);
      yield* requireTaskThread(scope, threadId, operation);
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const detail = yield* query
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError(() => failTaskTool(operation, `Could not read thread '${threadId}'.`)),
        );
      if (Option.isNone(detail)) {
        return yield* failTaskTool(operation, `Thread '${threadId}' was not found.`);
      }
      const page = yield* paginateTranscript(
        detail.value.messages,
        cursor,
        transcriptLimit(maxChars),
        operation,
      );
      return {
        threadId,
        ...page,
      };
    }),
  task_get_thread_diff: ({ threadId, fromTurn, toTurn }) =>
    Effect.gen(function* () {
      const operation = "task.get_thread_diff";
      const scope = yield* requireTaskScope(operation);
      const thread = yield* requireTaskThread(scope, threadId, operation);
      if (!thread.worktreePath) {
        return yield* diffFail(
          "checkout-unavailable",
          `Thread '${threadId}' has no available Git checkout.`,
        );
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
        return yield* diffFail(
          "checkpoint-unavailable",
          `Thread '${threadId}' has no completed Git checkpoint.`,
        );
      }
      if (resolvedFrom > resolvedTo || resolvedFrom > lastTurn || resolvedTo > lastTurn) {
        return yield* diffFail(
          "invalid-range",
          `The requested turn range is unavailable for '${threadId}'.`,
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
        .pipe(Effect.mapError((error) => classifyCheckpointDiffError(threadId, error)));
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
  isActiveTaskThread,
  classifyCheckpointDiffError,
  statusForThread,
  encodeCursor,
  decodeCursor,
  paginateTranscript,
  transcriptLimit,
  decodeListCursor,
  encodeListCursor,
  paginateList,
  listLimit,
};

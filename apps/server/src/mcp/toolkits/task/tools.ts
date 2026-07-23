import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class TaskToolError extends Schema.TaggedErrorClass<TaskToolError>()("TaskToolError", {
  operation: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}

const TaskRepositorySummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});

const TaskThreadOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
  }),
]);

const TaskThreadStatus = Schema.Literals([
  "idle",
  "working",
  "approval",
  "input",
  "failed",
  "ready",
]);

const TaskThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  origin: TaskThreadOrigin,
  status: TaskThreadStatus,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

const TaskTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});

const readonlyTaskTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export const TaskListRepositoriesTool = readonlyTaskTool(
  Tool.make("task_list_repositories", {
    description:
      "List repositories approved for the current T3 task. Repository approval is managed by the user and listing does not create a checkout.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      taskId: TaskId,
      repositories: Schema.Array(TaskRepositorySummary),
    }),
    failure: TaskToolError,
    dependencies,
  }).annotate(Tool.Title, "List task repositories"),
);

export const TaskListThreadsTool = readonlyTaskTool(
  Tool.make("task_list_threads", {
    description:
      "List durable user-created and agent-created threads in the current T3 task, including status, lineage, repository, branch, and checkout path.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      taskId: TaskId,
      threads: Schema.Array(TaskThreadSummary),
    }),
    failure: TaskToolError,
    dependencies,
  }).annotate(Tool.Title, "List task threads"),
);

export const TaskGetThreadStatusTool = readonlyTaskTool(
  Tool.make("task_get_thread_status", {
    description:
      "Read the current status of one durable thread in this task. Threads outside the current task are not accessible.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: TaskThreadSummary,
    failure: TaskToolError,
    dependencies,
  }).annotate(Tool.Title, "Get task thread status"),
);

export const TaskReadThreadTool = readonlyTaskTool(
  Tool.make("task_read_thread", {
    description:
      "Read a bounded page of transcript messages from one thread in this task. Pass the returned opaque cursor to continue.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      cursor: Schema.optionalKey(TrimmedNonEmptyString),
      maxChars: Schema.optionalKey(NonNegativeInt),
    }),
    success: Schema.Struct({
      threadId: ThreadId,
      messages: Schema.Array(TaskTranscriptMessage),
      nextCursor: Schema.NullOr(TrimmedNonEmptyString),
      truncated: Schema.Boolean,
    }),
    failure: TaskToolError,
    dependencies,
  }).annotate(Tool.Title, "Read task thread"),
);

export const TaskGetThreadDiffTool = readonlyTaskTool(
  Tool.make("task_get_thread_diff", {
    description: "Read a bounded Git checkpoint diff for a repository-bound thread in this task.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      fromTurn: Schema.optionalKey(NonNegativeInt),
      toTurn: Schema.optionalKey(NonNegativeInt),
    }),
    success: Schema.Struct({
      threadId: ThreadId,
      fromTurn: NonNegativeInt,
      toTurn: NonNegativeInt,
      diff: Schema.String,
      truncated: Schema.Boolean,
    }),
    failure: TaskToolError,
    dependencies: [...dependencies, CheckpointDiffQuery.CheckpointDiffQuery],
  }).annotate(Tool.Title, "Get task thread diff"),
);

export const TaskToolkit = Toolkit.make(
  TaskListRepositoriesTool,
  TaskListThreadsTool,
  TaskGetThreadStatusTool,
  TaskReadThreadTool,
  TaskGetThreadDiffTool,
);

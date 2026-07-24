import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as TaskWorkspaceService from "../../../tasks/TaskWorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TaskToolError } from "./tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
  GitWorkflowService.GitWorkflowService,
  ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  TaskWorkspaceService.TaskWorkspaceService,
  Crypto.Crypto,
];

const TaskCoordinationThreadStatus = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["idle", "working", "approval", "input", "failed", "ready"]),
});

export const TaskSpawnThreadTool = Tool.make("task_spawn_thread", {
  description:
    "Create a durable agent-owned T3 thread in the current task. The exact message becomes its first ordinary input. Omit projectId for the task workspace or provide an approved repository to create a new isolated worktree. For repository threads, baseRef must name an existing local or remote branch; HEAD resolves to the current branch.",
  parameters: Schema.Struct({
    message: TrimmedNonEmptyString,
    projectId: Schema.optionalKey(ProjectId),
    baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  }),
  failure: TaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn task thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const TaskSendMessageTool = Tool.make("task_send_message", {
  description:
    "Send a follow-up coordination message to an agent-created thread in the current task.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    accepted: Schema.Boolean,
  }),
  failure: TaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message task thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const TaskWaitForThreadsTool = Tool.make("task_wait_for_threads", {
  description:
    "Wait for a bounded interval, then return current statuses for selected threads in this task. Re-invoke to continue waiting.",
  parameters: Schema.Struct({
    threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    waitMs: Schema.optionalKey(NonNegativeInt),
  }),
  success: Schema.Struct({
    threads: Schema.Array(TaskCoordinationThreadStatus),
    timedOut: Schema.Boolean,
  }),
  failure: TaskToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Wait for task threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const TaskCreatePullRequestTool = Tool.make("task_create_pull_request", {
  description:
    "Push the selected repository-bound task thread when needed and create or return its current pull request. The thread checkout remains the source of truth.",
  parameters: Schema.Struct({
    threadId: ThreadId,
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    status: Schema.Literals(["created", "opened_existing", "skipped_not_requested"]),
    url: Schema.optionalKey(Schema.String),
    number: Schema.optionalKey(NonNegativeInt),
    baseBranch: Schema.optionalKey(TrimmedNonEmptyString),
    headBranch: Schema.optionalKey(TrimmedNonEmptyString),
    title: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  failure: TaskToolError,
  dependencies: [...dependencies, GitManager.GitManager],
})
  .annotate(Tool.Title, "Create task thread pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const TaskCoordinationToolkit = Toolkit.make(
  TaskSpawnThreadTool,
  TaskSendMessageTool,
  TaskWaitForThreadsTool,
  TaskCreatePullRequestTool,
);

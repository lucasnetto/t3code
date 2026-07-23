import type {
  OrchestrationProjectShell,
  OrchestrationTask,
  OrchestrationThreadShell,
  TaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

export class TaskWorkspaceError extends Schema.TaggedErrorClass<TaskWorkspaceError>()(
  "TaskWorkspaceError",
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface PrepareTaskWorkspaceInput {
  readonly task: OrchestrationTask;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

export interface TaskWorkspaceServiceShape {
  readonly newTaskRoot: (taskId: TaskId) => string;
  readonly managedWorktreePath: (input: {
    readonly taskRoot: string;
    readonly threadId: ThreadId;
    readonly projectTitle: string;
  }) => string;
  readonly prepare: (input: PrepareTaskWorkspaceInput) => Effect.Effect<void, TaskWorkspaceError>;
}

export class TaskWorkspaceService extends Context.Service<
  TaskWorkspaceService,
  TaskWorkspaceServiceShape
>()("t3/tasks/TaskWorkspaceService") {}

function safeIdSegment(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
    ? value
    : `id-${Encoding.encodeBase64Url(value)}`;
}

function slugSegment(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "repository";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function taskMarkdown(input: PrepareTaskWorkspaceInput): string {
  const projectById = new Map(input.projects.map((project) => [project.id, project] as const));
  const approvedRepositories =
    input.task.approvedProjectIds.length === 0
      ? ["- None approved yet."]
      : input.task.approvedProjectIds.map((projectId) => {
          const project = projectById.get(projectId);
          return `- ${oneLine(project?.title ?? projectId)} (\`${projectId}\`)`;
        });
  const taskThreads = input.threads
    .filter((thread) => thread.taskContext?.taskId === input.task.id)
    .map((thread) => {
      const origin =
        thread.taskContext?.createdBy.kind === "agent"
          ? `agent-created by \`${thread.taskContext.createdBy.threadId}\``
          : "user-created";
      const project = projectById.get(thread.projectId);
      const workspace = project?.visibility === "internal-task" ? "task root" : project?.title;
      return `- ${oneLine(thread.title)} (\`${thread.id}\`) — ${origin}; ${oneLine(workspace ?? thread.projectId)}`;
    });

  return [
    `# ${oneLine(input.task.title)}`,
    "",
    `Task ID: \`${input.task.id}\``,
    `Status: \`${input.task.status}\``,
    "",
    "## Approved repositories",
    "",
    ...approvedRepositories,
    "",
    "## Threads",
    "",
    ...(taskThreads.length > 0 ? taskThreads : ["- No durable threads yet."]),
    "",
    "## Coordination",
    "",
    "Use task-scoped tools from a user-created task thread to list repositories and threads, spawn durable agent threads, send follow-up messages, wait for progress, and inspect results.",
    "Repository-bound work belongs in the owning thread worktree under `worktrees/`.",
    "",
  ].join("\n");
}

const makeTaskWorkspaceService = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const newTaskRoot = (taskId: TaskId): string =>
    path.resolve(config.worktreesDir, "tasks", safeIdSegment(taskId));

  const managedWorktreePath: TaskWorkspaceServiceShape["managedWorktreePath"] = (input) =>
    path.resolve(
      input.taskRoot,
      "worktrees",
      `${safeIdSegment(input.threadId)}-${slugSegment(input.projectTitle)}`,
    );

  const prepare: TaskWorkspaceServiceShape["prepare"] = Effect.fn("TaskWorkspaceService.prepare")(
    function* (input) {
      const worktreesPath = path.join(input.task.rootPath, "worktrees");
      yield* fileSystem.makeDirectory(worktreesPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new TaskWorkspaceError({
              operation: "prepare-directory",
              path: worktreesPath,
              cause,
            }),
        ),
      );
      const contextPath = path.join(input.task.rootPath, "TASK.md");
      yield* writeFileStringAtomically({
        filePath: contextPath,
        contents: taskMarkdown(input),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new TaskWorkspaceError({
              operation: "write-context",
              path: contextPath,
              cause,
            }),
        ),
      );
    },
  );

  return TaskWorkspaceService.of({
    newTaskRoot,
    managedWorktreePath,
    prepare,
  });
});

export const TaskWorkspaceServiceLive = Layer.effect(
  TaskWorkspaceService,
  makeTaskWorkspaceService,
);

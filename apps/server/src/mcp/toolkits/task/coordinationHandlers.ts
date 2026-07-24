import {
  CommandId,
  GitManagerError,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import * as GitManager from "../../../git/GitManager.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as TaskWorkspaceService from "../../../tasks/TaskWorkspaceService.ts";
import type { GitCreatedBranch } from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  failTaskTool,
  requireActiveTaskMutationScope,
  requireTaskScope,
  requireTaskThread,
  statusForThread,
} from "./handlers.ts";
import { TaskCoordinationToolkit } from "./coordinationTools.ts";
import { TaskToolError } from "./tools.ts";

const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 10_000;
const MAX_BASE_REF_PAGE_SIZE = 200;
const isTaskToolError = Schema.is(TaskToolError);

function titleFromMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || "Task thread";
  return firstLine.slice(0, 80);
}

const resolveSpawnBaseRef = Effect.fn("TaskCoordinationToolkit.resolveSpawnBaseRef")(function* (
  git: GitWorkflowService.GitWorkflowService["Service"],
  cwd: string,
  requestedBaseRef: string | undefined,
) {
  const operation = "task.spawn_thread";
  const requestedName = requestedBaseRef ?? "HEAD";
  if (requestedName.startsWith("-")) {
    return yield* failTaskTool(operation, `Base ref '${requestedName}' must not start with '-'.`);
  }

  const resolveCurrentBranch = requestedName === "HEAD";
  let cursor: number | undefined;
  while (true) {
    const page = yield* git
      .listRefs({
        cwd,
        ...(resolveCurrentBranch ? {} : { query: requestedName }),
        cursor,
        includeMatchingRemoteRefs: true,
        limit: MAX_BASE_REF_PAGE_SIZE,
      })
      .pipe(
        Effect.mapError(() =>
          failTaskTool(operation, `Could not validate base ref '${requestedName}'.`),
        ),
      );
    if (!page.isRepo) {
      return yield* failTaskTool(operation, "Task repositories must be Git repositories.");
    }

    const resolved = resolveCurrentBranch
      ? page.refs.find((ref) => ref.current && ref.isRemote !== true)
      : page.refs.find((ref) => ref.name === requestedName);
    if (resolved) {
      return resolved.name;
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }

  return yield* failTaskTool(
    operation,
    resolveCurrentBranch
      ? "The repository has no current branch. Specify an existing local or remote branch."
      : `Base ref '${requestedName}' is not an existing local or remote branch.`,
  );
});

function pullRequestTargetUnavailableDetail(
  scope: {
    readonly task: {
      readonly approvedProjectIds: ReadonlyArray<ProjectId>;
    };
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  },
  target: OrchestrationThreadShell,
): string | null {
  if (
    !scope.task.approvedProjectIds.includes(target.projectId) ||
    !scope.projects.some((project) => project.id === target.projectId)
  ) {
    return `Thread '${target.id}' is not bound to an approved task repository.`;
  }
  if (!target.worktreePath) {
    return `Thread '${target.id}' has no repository checkout.`;
  }
  if (target.archivedAt) {
    return `Thread '${target.id}' is archived.`;
  }
  if (
    target.latestTurn?.state === "running" ||
    target.session?.status === "starting" ||
    target.session?.status === "running" ||
    target.session?.activeTurnId ||
    target.hasPendingApprovals ||
    target.hasPendingUserInput
  ) {
    return `Thread '${target.id}' is not idle.`;
  }
  return null;
}

function pullRequestTargetIdentity(target: OrchestrationThreadShell) {
  return {
    taskId: target.taskContext?.taskId ?? null,
    projectId: target.projectId,
    worktreePath: target.worktreePath,
    branch: target.branch,
    turnId: target.latestTurn?.turnId ?? null,
    turnState: target.latestTurn?.state ?? null,
    sessionStatus: target.session?.status ?? null,
    sessionTurnId: target.session?.activeTurnId ?? null,
  };
}

function pullRequestTargetIdentityMatches(
  left: ReturnType<typeof pullRequestTargetIdentity>,
  right: ReturnType<typeof pullRequestTargetIdentity>,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.projectId === right.projectId &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.turnId === right.turnId &&
    left.turnState === right.turnState &&
    left.sessionStatus === right.sessionStatus &&
    left.sessionTurnId === right.sessionTurnId
  );
}

const handlers = {
  task_spawn_thread: Effect.fn("TaskCoordinationToolkit.task_spawn_thread")(function* ({
    message,
    projectId,
    baseRef,
  }) {
    const operation = "task.spawn_thread";
    const scope = yield* requireActiveTaskMutationScope(operation);
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const caller = scope.caller;
    const spawningTurnId = scope.activeTurnId;

    const targetProjectId = projectId ?? scope.task.workspaceProjectId;
    const project = scope.projects.find((candidate) => candidate.id === targetProjectId);
    if (!project) {
      return yield* failTaskTool(
        operation,
        `Project '${targetProjectId}' is not available in this task.`,
      );
    }
    if (
      targetProjectId !== scope.task.workspaceProjectId &&
      !scope.task.approvedProjectIds.includes(targetProjectId)
    ) {
      return yield* failTaskTool(
        operation,
        `Project '${targetProjectId}' is not approved for this task.`,
      );
    }
    if (targetProjectId === scope.task.workspaceProjectId && baseRef !== undefined) {
      return yield* failTaskTool(
        operation,
        "baseRef is only valid when spawning a repository-bound task thread.",
      );
    }

    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failTaskTool(operation, "Could not allocate thread identifiers.")),
    );
    const threadId = ThreadId.make(uuid);
    const commandId = (suffix: string) => CommandId.make(`task:${suffix}:${uuid}`);
    const messageId = MessageId.make(`task:message:${uuid}`);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const git = yield* GitWorkflowService.GitWorkflowService;
    const taskWorkspace = yield* TaskWorkspaceService.TaskWorkspaceService;
    const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    let createdThread = false;
    let createdWorktree: string | null = null;
    let createdBranch: GitCreatedBranch | null = null;
    let branch: string | null = null;

    const cleanup = Effect.gen(function* () {
      let worktreeRemoved = createdWorktree === null;
      if (createdWorktree !== null && createdBranch !== null) {
        const cleanupExit = yield* Effect.exit(
          git.cleanupCreatedWorktree({
            cwd: project.workspaceRoot,
            path: createdWorktree,
            createdBranch,
          }),
        );
        if (Exit.isSuccess(cleanupExit)) {
          worktreeRemoved = true;
          if (cleanupExit.value.branch === "retained") {
            yield* Effect.logWarning(
              "Task thread cleanup removed the worktree but retained its changed branch",
              {
                threadId,
                branch: createdBranch.refName,
                reason: cleanupExit.value.reason,
              },
            );
          }
        } else {
          yield* Effect.logWarning(
            "Task thread worktree cleanup failed; retaining its durable owner when available",
            {
              threadId,
              projectCwd: project.workspaceRoot,
              worktreePath: createdWorktree,
              cause: Cause.pretty(cleanupExit.cause),
              recovery:
                "Resolve or remove the retained worktree, then delete or retry the owning thread.",
            },
          );
        }
      } else if (createdWorktree !== null) {
        const removalExit = yield* Effect.exit(
          git.removeWorktree({
            cwd: project.workspaceRoot,
            path: createdWorktree,
          }),
        );
        worktreeRemoved = Exit.isSuccess(removalExit);
        yield* Effect.logWarning(
          worktreeRemoved
            ? "Task thread cleanup removed a worktree but retained its branch because creation proof was unavailable"
            : "Task thread cleanup lacked created-branch proof and could not remove its worktree",
          {
            threadId,
            worktreePath: createdWorktree,
            ...(Exit.isFailure(removalExit) ? { cause: Cause.pretty(removalExit.cause) } : {}),
            recovery: worktreeRemoved
              ? "Review and remove the retained branch if it is no longer needed."
              : "Resolve or remove the retained worktree, then delete or retry the owning thread.",
          },
        );
      }
      if (createdThread && worktreeRemoved) {
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: commandId("cleanup"),
            threadId,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      } else if (createdThread) {
        yield* Effect.logWarning(
          "Task thread cleanup retained the durable owner because its worktree was not removed",
          {
            threadId,
            worktreePath: createdWorktree,
            recovery:
              "Resolve or remove the retained worktree, then delete or retry the owning thread.",
          },
        );
      }
    }).pipe(Effect.uninterruptible);

    const program = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (targetProjectId !== scope.task.workspaceProjectId) {
          const resolvedBase = yield* restore(
            resolveSpawnBaseRef(git, project.workspaceRoot, baseRef),
          );
          const requestedBranch = `t3-task-${uuid}`;
          const path = taskWorkspace.managedWorktreePath({
            taskRoot: scope.task.rootPath,
            threadId,
            projectTitle: project.title,
          });
          // The create call and ownership registration are one commit point:
          // cancellation is observed only after the returned worktree is recorded.
          const worktree = yield* git.createWorktree({
            cwd: project.workspaceRoot,
            refName: resolvedBase,
            newRefName: requestedBranch,
            baseRefName: resolvedBase,
            path,
          });
          createdWorktree = worktree.worktree.path;
          createdBranch = worktree.createdBranch ?? null;
          branch = worktree.worktree.refName;
        }

        const createCommand: Extract<OrchestrationCommand, { type: "thread.agent.create" }> = {
          type: "thread.agent.create",
          commandId: commandId("create"),
          threadId,
          projectId: targetProjectId,
          taskId: scope.task.id,
          spawningThreadId: invocation.threadId,
          spawningTurnId,
          title: titleFromMessage(message),
          modelSelection: caller.modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch,
          worktreePath: createdWorktree,
          createdAt,
        };
        const refreshedScope = yield* restore(requireActiveTaskMutationScope(operation));
        if (refreshedScope.activeTurnId !== spawningTurnId) {
          return yield* failTaskTool(
            operation,
            "The calling provider turn changed before the task thread could be created.",
          );
        }
        // Dispatch and ownership registration are likewise one commit point.
        yield* engine.dispatch(createCommand);
        createdThread = true;

        if (createdWorktree) {
          yield* restore(
            setup
              .runForThread({
                threadId,
                projectId: targetProjectId,
                projectCwd: project.workspaceRoot,
                worktreePath: createdWorktree,
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Task thread setup script failed to launch", {
                    threadId,
                    cause,
                  }),
                ),
              ),
          );
        }

        yield* restore(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId,
            message: {
              messageId,
              role: "user",
              text: message,
              attachments: [],
            },
            modelSelection: createCommand.modelSelection,
            runtimeMode: createCommand.runtimeMode,
            interactionMode: createCommand.interactionMode,
            createdAt,
          }),
        );

        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        yield* restore(
          query.getShellSnapshot().pipe(
            Effect.flatMap((snapshot) =>
              taskWorkspace.prepare({
                task: scope.task,
                projects: snapshot.projects,
                threads: snapshot.threads,
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Failed to refresh task context after spawning thread", {
                threadId,
                cause,
              }),
            ),
          ),
        );

        return {
          threadId,
          projectId: targetProjectId,
          branch,
          worktreePath: createdWorktree,
        };
      }),
    );

    return yield* program.pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanup : Effect.void)),
      Effect.catchCause((cause) => {
        const interruptionReasons = cause.reasons.filter(Cause.isInterruptReason);
        if (interruptionReasons.length > 0) {
          return Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
        }
        const error = Cause.squash(cause);
        return Effect.fail(
          failTaskTool(
            operation,
            error instanceof Error ? error.message : "Could not spawn the task thread.",
          ),
        );
      }),
    );
  }),
  task_send_message: Effect.fn("TaskCoordinationToolkit.task_send_message")(function* ({
    threadId,
    message,
  }) {
    const operation = "task.send_message";
    const scope = yield* requireActiveTaskMutationScope(operation);
    const target = yield* requireTaskThread(scope, threadId, operation);
    if (target.taskContext?.createdBy.kind !== "agent") {
      return yield* failTaskTool(
        operation,
        "Follow-up messages may target only agent-created threads.",
      );
    }
    if (target.latestTurn?.state === "running") {
      return yield* failTaskTool(operation, `Thread '${threadId}' is still working.`);
    }
    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => failTaskTool(operation, "Could not allocate message identifiers.")),
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`task:message:${uuid}`),
        threadId,
        message: {
          messageId: MessageId.make(`task:message:${uuid}`),
          role: "user",
          text: message,
          attachments: [],
        },
        modelSelection: target.modelSelection,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt,
      })
      .pipe(
        Effect.mapError(() =>
          failTaskTool(operation, `Could not send a message to '${threadId}'.`),
        ),
      );
    return { threadId, accepted: true };
  }),
  task_wait_for_threads: Effect.fn("TaskCoordinationToolkit.task_wait_for_threads")(function* ({
    threadIds,
    waitMs,
  }) {
    const operation = "task.wait_for_threads";
    const initial = yield* requireTaskScope(operation);
    for (const threadId of threadIds) {
      yield* requireTaskThread(initial, threadId, operation);
    }
    const boundedWait = Math.min(waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
    if (boundedWait > 0) {
      yield* Effect.sleep(`${boundedWait} millis`);
    }
    const refreshed = yield* requireTaskScope(operation);
    const threads = yield* Effect.forEach(threadIds, (threadId) =>
      requireTaskThread(refreshed, threadId, operation),
    );
    return {
      threads: threads.map((thread) => ({
        threadId: thread.id,
        status: statusForThread(thread),
      })),
      timedOut: threads.some((thread) => statusForThread(thread) === "working"),
    };
  }),
  task_create_pull_request: Effect.fn("TaskCoordinationToolkit.task_create_pull_request")(
    function* ({ threadId }) {
      const operation = "task.create_pull_request";
      const scope = yield* requireTaskScope(operation);
      const target = yield* requireTaskThread(scope, threadId, operation);
      const worktreePath = target.worktreePath;
      if (!worktreePath) {
        return yield* failTaskTool(
          operation,
          `Thread '${threadId}' has no repository checkout.`,
          "unavailable",
        );
      }
      const unavailableDetail = pullRequestTargetUnavailableDetail(scope, target);
      if (unavailableDetail) {
        return yield* failTaskTool(operation, unavailableDetail, "unavailable");
      }
      const initialIdentity = pullRequestTargetIdentity(target);
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const beforeRemoteMutation = Effect.gen(function* () {
        const snapshot = yield* query
          .getShellSnapshot()
          .pipe(
            Effect.mapError(() =>
              failTaskTool(operation, "Could not revalidate the pull request target.", "conflict"),
            ),
          );
        const currentTask = snapshot.tasks?.find((candidate) => candidate.id === scope.task.id);
        const currentTarget = snapshot.threads.find(
          (candidate) =>
            candidate.id === threadId && candidate.taskContext?.taskId === scope.task.id,
        );
        if (!currentTask || currentTask.status !== "active" || !currentTarget) {
          return yield* failTaskTool(
            operation,
            `Thread '${threadId}' is no longer available in the active task.`,
            "conflict",
          );
        }
        const currentUnavailableDetail = pullRequestTargetUnavailableDetail(
          { task: currentTask, projects: snapshot.projects },
          currentTarget,
        );
        if (
          currentUnavailableDetail ||
          !pullRequestTargetIdentityMatches(
            initialIdentity,
            pullRequestTargetIdentity(currentTarget),
          )
        ) {
          return yield* failTaskTool(
            operation,
            `Thread '${threadId}' changed before its pull request workflow could begin.`,
            "conflict",
          );
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "task.create_pull_request.revalidate",
              cwd: worktreePath,
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failTaskTool(operation, "Could not allocate an action identifier.")),
      );
      const git = yield* GitManager.GitManager;
      const result = yield* git
        .runStackedAction(
          {
            actionId: `task:pr:${uuid}`,
            cwd: worktreePath,
            action: "create_pr",
          },
          { beforeRemoteMutation },
        )
        .pipe(
          Effect.mapError((error) => {
            if (
              error._tag === "GitManagerError" &&
              error.cause !== undefined &&
              isTaskToolError(error.cause)
            ) {
              return error.cause;
            }
            return failTaskTool(
              operation,
              error instanceof Error ? error.message : `Could not create a PR for '${threadId}'.`,
            );
          }),
        );
      return {
        threadId,
        status: result.pr.status,
        ...(result.pr.url ? { url: result.pr.url } : {}),
        ...(result.pr.number ? { number: result.pr.number } : {}),
        ...(result.pr.baseBranch ? { baseBranch: result.pr.baseBranch } : {}),
        ...(result.pr.headBranch ? { headBranch: result.pr.headBranch } : {}),
        ...(result.pr.title ? { title: result.pr.title } : {}),
      };
    },
  ),
} satisfies Parameters<typeof TaskCoordinationToolkit.toLayer>[0];

export const TaskCoordinationToolkitHandlersLive = TaskCoordinationToolkit.toLayer(handlers);

export const __testing = {
  titleFromMessage,
  pullRequestTargetUnavailableDetail,
  pullRequestTargetIdentity,
  pullRequestTargetIdentityMatches,
};

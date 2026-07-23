import {
  CommandId,
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

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as TaskWorkspaceService from "../../../tasks/TaskWorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { failTaskTool, requireTaskScope, requireTaskThread, statusForThread } from "./handlers.ts";
import { TaskCoordinationToolkit } from "./coordinationTools.ts";

const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 10_000;

function titleFromMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || "Task thread";
  return firstLine.slice(0, 80);
}

const handlers = {
  task_spawn_thread: ({ message, projectId, baseRef }) =>
    Effect.gen(function* () {
      const operation = "task.spawn_thread";
      const scope = yield* requireTaskScope(operation);
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* requireTaskThread(scope, invocation.threadId, operation);
      const spawningTurnId = caller.latestTurn?.turnId;
      if (!spawningTurnId || caller.latestTurn?.state !== "running") {
        return yield* failTaskTool(
          operation,
          "The calling thread must have an active turn to spawn a durable thread.",
        );
      }

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
      let branch: string | null = null;

      const cleanup = Effect.gen(function* () {
        if (createdWorktree) {
          yield* git
            .removeWorktree({ cwd: project.workspaceRoot, path: createdWorktree })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        if (createdThread) {
          yield* engine
            .dispatch({
              type: "thread.delete",
              commandId: commandId("cleanup"),
              threadId,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
      });

      const program = Effect.gen(function* () {
        if (targetProjectId !== scope.task.workspaceProjectId) {
          const requestedBase = baseRef ?? "HEAD";
          const requestedBranch = `t3-task-${uuid}`;
          const path = taskWorkspace.managedWorktreePath({
            taskRoot: scope.task.rootPath,
            threadId,
            projectTitle: project.title,
          });
          const worktree = yield* git.createWorktree({
            cwd: project.workspaceRoot,
            refName: requestedBase,
            newRefName: requestedBranch,
            baseRefName: requestedBase,
            path,
          });
          createdWorktree = worktree.worktree.path;
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
          modelSelection: project.defaultModelSelection ?? caller.modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch,
          worktreePath: createdWorktree,
          createdAt,
        };
        yield* engine.dispatch(createCommand);
        createdThread = true;

        if (createdWorktree) {
          yield* setup
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
            );
        }

        yield* engine.dispatch({
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
        });

        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        yield* query.getShellSnapshot().pipe(
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
        );

        return {
          threadId,
          projectId: targetProjectId,
          branch,
          worktreePath: createdWorktree,
        };
      });

      return yield* program.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return cleanup.pipe(
            Effect.andThen(
              Effect.fail(
                failTaskTool(
                  operation,
                  error instanceof Error ? error.message : "Could not spawn the task thread.",
                ),
              ),
            ),
          );
        }),
      );
    }),
  task_send_message: ({ threadId, message }) =>
    Effect.gen(function* () {
      const operation = "task.send_message";
      const scope = yield* requireTaskScope(operation);
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
  task_wait_for_threads: ({ threadIds, waitMs }) =>
    Effect.gen(function* () {
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
} satisfies Parameters<typeof TaskCoordinationToolkit.toLayer>[0];

export const TaskCoordinationToolkitHandlersLive = TaskCoordinationToolkit.toLayer(handlers);

export const __testing = {
  titleFromMessage,
};

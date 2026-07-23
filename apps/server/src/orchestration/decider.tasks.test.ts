import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-23T12:00:00.000Z";

const projectCreated = (
  sequence: number,
  projectId: ProjectId,
  workspaceRoot: string,
): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-project-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make(`command-project-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId,
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    visibility: "visible",
  },
});

const createTask = (readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    readModel,
    command: {
      type: "task.create",
      commandId: CommandId.make("command-task-create"),
      taskId: TaskId.make("task-1"),
      title: "Coordinate release",
      rootPath: "/tmp/t3/tasks/task-1",
      workspaceProjectId: ProjectId.make("project-task-1"),
      approvedProjectIds: [ProjectId.make("project-api")],
      createdAt: now,
    },
  }).pipe(Effect.map((events) => (Array.isArray(events) ? events : [events])));

it.layer(NodeServices.layer)("task decider", (it) => {
  it.effect("creates the hidden workspace project and task atomically", () =>
    Effect.gen(function* () {
      const base = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
      );
      const events = yield* createTask(base);

      expect(events.map((event) => event.type)).toEqual(["project.created", "task.created"]);
      expect(events[0]?.payload).toMatchObject({
        projectId: "project-task-1",
        workspaceRoot: "/tmp/t3/tasks/task-1",
        visibility: "internal-task",
      });
      expect(events[1]?.payload).toMatchObject({
        taskId: "task-1",
        approvedProjectIds: ["project-api"],
        status: "active",
      });
    }),
  );

  it.effect("atomically creates the first user task thread with the task", () =>
    Effect.gen(function* () {
      const base = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
      );
      const result = yield* decideOrchestrationCommand({
        readModel: base,
        command: {
          type: "task.create",
          commandId: CommandId.make("command-task-first-thread"),
          taskId: TaskId.make("task-first-thread"),
          title: "Coordinate release",
          rootPath: "/tmp/t3/tasks/task-first-thread",
          workspaceProjectId: ProjectId.make("project-task-first-thread"),
          approvedProjectIds: [ProjectId.make("project-api")],
          initialThread: {
            threadId: ThreadId.make("thread-coordinator"),
            title: "Coordinate release",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
          createdAt: now,
        },
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "project.created",
        "task.created",
        "thread.created",
      ]);
      expect(events[2]?.payload).toMatchObject({
        threadId: "thread-coordinator",
        projectId: "project-task-first-thread",
        taskContext: {
          taskId: "task-first-thread",
          createdBy: { kind: "user" },
        },
      });
    }),
  );

  it.effect("records user and agent thread lineage without changing standalone threads", () =>
    Effect.gen(function* () {
      let readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
      );
      const taskEvents = yield* createTask(readModel);
      for (const [index, event] of taskEvents.entries()) {
        readModel = yield* projectEvent(readModel, { ...event, sequence: index + 2 });
      }

      const userResult = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-user-thread"),
          threadId: ThreadId.make("thread-user"),
          projectId: ProjectId.make("project-task-1"),
          taskId: TaskId.make("task-1"),
          title: "Coordinate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
      });
      const userEvent = Array.isArray(userResult) ? userResult[0] : userResult;
      expect(userEvent.payload).toMatchObject({
        taskContext: {
          taskId: "task-1",
          createdBy: { kind: "user" },
        },
      });
      readModel = yield* projectEvent(readModel, { ...userEvent, sequence: 4 });

      const agentCommand: OrchestrationCommand = {
        type: "thread.agent.create",
        commandId: CommandId.make("command-agent-thread"),
        threadId: ThreadId.make("thread-agent"),
        projectId: ProjectId.make("project-api"),
        taskId: TaskId.make("task-1"),
        spawningThreadId: ThreadId.make("thread-user"),
        spawningTurnId: TurnId.make("turn-1"),
        title: "Implement API",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/api",
        worktreePath: "/tmp/t3/tasks/task-1/worktrees/thread-agent-api",
        createdAt: now,
      };
      const agentResult = yield* decideOrchestrationCommand({
        readModel,
        command: agentCommand,
      });
      const agentEvent = Array.isArray(agentResult) ? agentResult[0] : agentResult;
      expect(agentEvent.payload).toMatchObject({
        taskContext: {
          taskId: "task-1",
          createdBy: {
            kind: "agent",
            threadId: "thread-user",
            turnId: "turn-1",
          },
        },
      });
    }),
  );

  it.effect("rejects task threads for repositories outside the approved set", () =>
    Effect.gen(function* () {
      let readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
      );
      readModel = yield* projectEvent(
        readModel,
        projectCreated(2, ProjectId.make("project-web"), "/tmp/web"),
      );
      const taskEvents = yield* createTask(readModel);
      for (const [index, event] of taskEvents.entries()) {
        readModel = yield* projectEvent(readModel, { ...event, sequence: index + 3 });
      }

      const result = yield* Effect.result(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("command-unapproved-thread"),
            threadId: ThreadId.make("thread-web"),
            projectId: ProjectId.make("project-web"),
            taskId: TaskId.make("task-1"),
            title: "Unapproved",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});

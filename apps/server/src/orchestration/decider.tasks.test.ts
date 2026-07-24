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
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
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

const createAgentCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.agent.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.agent.create" }> => ({
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
  ...overrides,
});

const createUserCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
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
  ...overrides,
});

const updateProject = (
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
  update: (project: OrchestrationProject) => OrchestrationProject,
): OrchestrationReadModel => ({
  ...readModel,
  projects: readModel.projects.map((project) =>
    project.id === projectId ? update(project) : project,
  ),
});

const updateThread = (
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  update: (thread: OrchestrationThread) => OrchestrationThread,
): OrchestrationReadModel => ({
  ...readModel,
  threads: readModel.threads.map((thread) => (thread.id === threadId ? update(thread) : thread)),
});

const createTaskReadModel = Effect.fn("createTaskReadModel")(function* () {
  let readModel = yield* projectEvent(
    createEmptyReadModel(now),
    projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
  );
  const taskEvents = yield* createTask(readModel);
  for (const [index, event] of taskEvents.entries()) {
    readModel = yield* projectEvent(readModel, { ...event, sequence: index + 2 });
  }
  return readModel;
});

const createTaskWithActiveUserThread = Effect.fn("createTaskWithActiveUserThread")(function* () {
  let readModel = yield* createTaskReadModel();
  const userResult = yield* decideOrchestrationCommand({
    readModel,
    command: createUserCommand(),
  });
  const userEvent = Array.isArray(userResult) ? userResult[0] : userResult;
  readModel = yield* projectEvent(readModel, { ...userEvent, sequence: 4 });

  const sessionResult = yield* decideOrchestrationCommand({
    readModel,
    command: {
      type: "thread.session.set",
      commandId: CommandId.make("command-user-session"),
      threadId: ThreadId.make("thread-user"),
      session: {
        threadId: ThreadId.make("thread-user"),
        status: "running",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    },
  });
  const sessionEvents = Array.isArray(sessionResult) ? sessionResult : [sessionResult];
  for (const [index, event] of sessionEvents.entries()) {
    readModel = yield* projectEvent(readModel, { ...event, sequence: index + 5 });
  }

  return readModel;
});

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

  it.effect("rejects deleted repositories during task creation", () =>
    Effect.gen(function* () {
      const activeReadModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated(1, ProjectId.make("project-api"), "/tmp/api"),
      );
      const deletedReadModel = updateProject(
        activeReadModel,
        ProjectId.make("project-api"),
        (project) => ({
          ...project,
          deletedAt: now,
        }),
      );

      const result = yield* Effect.result(createTask(deletedReadModel));
      expect(result._tag).toBe("Failure");
      if (
        result._tag === "Failure" &&
        result.failure._tag === "OrchestrationCommandInvariantError"
      ) {
        expect(result.failure.detail).toContain("is deleted");
      }
    }),
  );

  it.effect("approves only active visible repositories", () =>
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

      const command = {
        type: "task.repository.approve",
        commandId: CommandId.make("command-approve-web"),
        taskId: TaskId.make("task-1"),
        projectId: ProjectId.make("project-web"),
        approvedAt: now,
      } as const;
      const validResult = yield* decideOrchestrationCommand({ readModel, command });
      const validEvent = Array.isArray(validResult) ? validResult[0] : validResult;
      expect(validEvent?.type).toBe("task.repository-approved");

      const deletedReadModel = updateProject(
        readModel,
        ProjectId.make("project-web"),
        (project) => ({
          ...project,
          deletedAt: now,
        }),
      );
      const deletedResult = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: deletedReadModel,
          command,
        }),
      );
      expect(deletedResult._tag).toBe("Failure");
      if (
        deletedResult._tag === "Failure" &&
        deletedResult.failure._tag === "OrchestrationCommandInvariantError"
      ) {
        expect(deletedResult.failure.detail).toContain("is deleted");
      }
    }),
  );

  it.effect("requires active repositories for task-aware threads only", () =>
    Effect.gen(function* () {
      const activeReadModel = yield* createTaskWithActiveUserThread();
      const validUserResult = yield* decideOrchestrationCommand({
        readModel: activeReadModel,
        command: createUserCommand({
          commandId: CommandId.make("command-user-api"),
          threadId: ThreadId.make("thread-user-api"),
          projectId: ProjectId.make("project-api"),
          branch: "feature/user-api",
          worktreePath: "/tmp/t3/tasks/task-1/worktrees/thread-user-api",
        }),
      });
      const validUserEvent = Array.isArray(validUserResult) ? validUserResult[0] : validUserResult;
      expect(validUserEvent?.type).toBe("thread.created");

      const validAgentResult = yield* decideOrchestrationCommand({
        readModel: activeReadModel,
        command: createAgentCommand(),
      });
      const validAgentEvent = Array.isArray(validAgentResult)
        ? validAgentResult[0]
        : validAgentResult;
      expect(validAgentEvent?.type).toBe("thread.created");

      const deletedReadModel = updateProject(
        activeReadModel,
        ProjectId.make("project-api"),
        (project) => ({
          ...project,
          deletedAt: now,
        }),
      );
      const deletedUserResult = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: deletedReadModel,
          command: createUserCommand({
            commandId: CommandId.make("command-user-deleted"),
            threadId: ThreadId.make("thread-user-deleted"),
            projectId: ProjectId.make("project-api"),
          }),
        }),
      );
      const deletedAgentResult = yield* Effect.result(
        decideOrchestrationCommand({
          readModel: deletedReadModel,
          command: createAgentCommand(),
        }),
      );
      for (const result of [deletedUserResult, deletedAgentResult]) {
        expect(result._tag).toBe("Failure");
        if (
          result._tag === "Failure" &&
          result.failure._tag === "OrchestrationCommandInvariantError"
        ) {
          expect(result.failure.detail).toContain("is deleted");
        }
      }

      const standaloneResult = yield* decideOrchestrationCommand({
        readModel: deletedReadModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-standalone-deleted"),
          threadId: ThreadId.make("thread-standalone-deleted"),
          projectId: ProjectId.make("project-api"),
          title: "Standalone legacy thread",
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
      const standaloneEvent = Array.isArray(standaloneResult)
        ? standaloneResult[0]
        : standaloneResult;
      expect(standaloneEvent?.type).toBe("thread.created");
    }),
  );

  it.effect("records user and agent thread lineage without changing standalone threads", () =>
    Effect.gen(function* () {
      const readModel = yield* createTaskWithActiveUserThread();
      const userThread = readModel.threads.find((thread) => thread.id === "thread-user");
      expect(userThread?.taskContext).toEqual({
        taskId: "task-1",
        createdBy: { kind: "user" },
      });

      const agentResult = yield* decideOrchestrationCommand({
        readModel,
        command: createAgentCommand(),
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

  it.effect("rejects invalid agent-thread lineage", () =>
    Effect.gen(function* () {
      const activeReadModel = yield* createTaskWithActiveUserThread();
      if (activeReadModel.tasks === undefined) {
        return yield* Effect.die(new Error("task fixture did not project tasks"));
      }
      const sourceThreadId = ThreadId.make("thread-user");
      const invalidCases: ReadonlyArray<{
        readonly name: string;
        readonly readModel: OrchestrationReadModel;
        readonly command?: Partial<Extract<OrchestrationCommand, { type: "thread.agent.create" }>>;
        readonly detail: string;
      }> = [
        {
          name: "agent-created parent",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            taskContext: {
              taskId: TaskId.make("task-1"),
              createdBy: {
                kind: "agent",
                threadId: ThreadId.make("thread-parent"),
                turnId: TurnId.make("turn-parent"),
              },
            },
          })),
          detail: "must be user-created",
        },
        {
          name: "deleted source",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            deletedAt: now,
          })),
          detail: "is deleted",
        },
        {
          name: "archived source",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            archivedAt: now,
          })),
          detail: "is archived",
        },
        {
          name: "settled source",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            settledOverride: "settled",
            settledAt: now,
          })),
          detail: "is settled",
        },
        {
          name: "stale source turn",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            latestTurn:
              thread.latestTurn === null
                ? null
                : {
                    ...thread.latestTurn,
                    state: "completed",
                    completedAt: now,
                  },
            session:
              thread.session === null
                ? null
                : {
                    ...thread.session,
                    status: "ready",
                    activeTurnId: null,
                  },
          })),
          detail: "is not the active turn",
        },
        {
          name: "wrong turn",
          readModel: activeReadModel,
          command: { spawningTurnId: TurnId.make("turn-old") },
          detail: "is not the active turn",
        },
        {
          name: "missing current turn",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            latestTurn: null,
            session: null,
          })),
          detail: "is not the active turn",
        },
        {
          name: "cross-task source",
          readModel: updateThread(activeReadModel, sourceThreadId, (thread) => ({
            ...thread,
            taskContext: {
              taskId: TaskId.make("task-2"),
              createdBy: { kind: "user" },
            },
          })),
          detail: "is outside task",
        },
        {
          name: "inactive target task",
          readModel: {
            ...activeReadModel,
            tasks: activeReadModel.tasks.map((task) =>
              task.id === "task-1"
                ? {
                    ...task,
                    status: "completed",
                    completedAt: now,
                  }
                : task,
            ),
          },
          detail: "is 'completed'",
        },
      ];

      for (const invalidCase of invalidCases) {
        const result = yield* Effect.result(
          decideOrchestrationCommand({
            readModel: invalidCase.readModel,
            command: createAgentCommand(invalidCase.command),
          }),
        );

        expect(result._tag, invalidCase.name).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag, invalidCase.name).toBe("OrchestrationCommandInvariantError");
          if (result.failure._tag === "OrchestrationCommandInvariantError") {
            expect(result.failure.detail, invalidCase.name).toContain(invalidCase.detail);
          }
        }
      }
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

import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type {
  OrchestrationProjectShell,
  OrchestrationTask,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ProviderInstanceId, TaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedThreadGroups } from "./archivedThreadGroups";

const environmentId = EnvironmentId.make("environment-1");
const createdAt = "2026-07-24T12:00:00.000Z";

function makeProject(
  input: Partial<OrchestrationProjectShell> & Pick<OrchestrationProjectShell, "id" | "title">,
): OrchestrationProjectShell {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThreadShell> &
    Pick<OrchestrationThreadShell, "id" | "projectId" | "title">,
): OrchestrationThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: createdAt,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    settledAt: null,
    ...input,
  };
}

function makeSnapshot(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly tasks?: ReadonlyArray<OrchestrationTask>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}): ArchivedSnapshotEntry {
  return {
    environmentId,
    snapshot: {
      snapshotSequence: 1,
      tasks: input.tasks ?? [],
      projects: input.projects,
      threads: input.threads,
      updatedAt: createdAt,
    },
  };
}

describe("buildArchivedThreadGroups", () => {
  it("uses task metadata instead of exposing an internal task project", () => {
    const project = makeProject({
      id: ProjectId.make("project-task-internal"),
      title: "Internal workspace",
      workspaceRoot: "/private/task-workspaces/task-1",
      visibility: "internal-task",
    });
    const taskId = TaskId.make("task-1");
    const task: OrchestrationTask = {
      id: taskId,
      title: "Ship the release",
      status: "active",
      rootPath: project.workspaceRoot,
      workspaceProjectId: project.id,
      approvedProjectIds: [],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    const thread = makeThread({
      id: ThreadId.make("thread-task-root"),
      projectId: project.id,
      title: "Release coordinator",
      taskContext: {
        taskId,
        createdBy: { kind: "user" },
      },
    });

    const result = buildArchivedThreadGroups([
      makeSnapshot({ projects: [project], tasks: [task], threads: [thread] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "task",
      project: null,
      title: "Task · Ship the release",
    });
    expect(result[0]?.threads.map((candidate) => candidate.id)).toEqual(["thread-task-root"]);
    expect(JSON.stringify(result)).not.toContain(project.workspaceRoot);
  });

  it("keeps ordinary archived projects grouped as repositories", () => {
    const project = makeProject({
      id: ProjectId.make("project-visible"),
      title: "T3 Code",
      visibility: "visible",
    });
    const thread = makeThread({
      id: ThreadId.make("thread-visible"),
      projectId: project.id,
      title: "Visible archived thread",
    });

    const result = buildArchivedThreadGroups([
      makeSnapshot({ projects: [project], threads: [thread] }),
    ]);

    expect(result[0]).toMatchObject({
      kind: "project",
      title: "T3 Code",
      project: {
        id: project.id,
        cwd: project.workspaceRoot,
      },
    });
  });
});

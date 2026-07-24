import { isOrdinaryProjectShell } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationTask,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";

export interface ArchivedThreadGroupProject {
  readonly environmentId: EnvironmentId;
  readonly id: OrchestrationProjectShell["id"];
  readonly name: string;
  readonly cwd: string;
}

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly kind: "project" | "task";
  readonly title: string;
  readonly project: ArchivedThreadGroupProject | null;
  readonly threads: ReadonlyArray<
    OrchestrationThreadShell & { readonly environmentId: EnvironmentId }
  >;
}

function sortThreads(
  threads: ReadonlyArray<OrchestrationThreadShell & { readonly environmentId: EnvironmentId }>,
): ReadonlyArray<OrchestrationThreadShell & { readonly environmentId: EnvironmentId }> {
  return threads.toSorted((left, right) => {
    const leftKey = left.archivedAt ?? left.createdAt;
    const rightKey = right.archivedAt ?? right.createdAt;
    return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
  });
}

function taskTitle(tasks: ReadonlyArray<OrchestrationTask>, taskId: string | null): string {
  if (taskId === null) {
    return "Task threads";
  }
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? `Task · ${task.title}` : "Task threads";
}

export function buildArchivedThreadGroups(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
): ReadonlyArray<ArchivedThreadGroup> {
  const groups: ArchivedThreadGroup[] = [];

  for (const { environmentId, snapshot } of snapshots) {
    const threadsByProjectId = new Map<string, OrchestrationThreadShell[]>();
    for (const thread of snapshot.threads) {
      const projectThreads = threadsByProjectId.get(thread.projectId) ?? [];
      projectThreads.push(thread);
      threadsByProjectId.set(thread.projectId, projectThreads);
    }

    for (const project of snapshot.projects) {
      const projectThreads = threadsByProjectId.get(project.id) ?? [];
      if (projectThreads.length === 0) {
        continue;
      }

      if (isOrdinaryProjectShell(project)) {
        groups.push({
          key: `${environmentId}:project:${project.id}`,
          kind: "project",
          title: project.title,
          project: {
            id: project.id,
            environmentId,
            name: project.title,
            cwd: project.workspaceRoot,
          },
          threads: sortThreads(
            projectThreads.map((thread) => ({
              ...thread,
              environmentId,
            })),
          ),
        });
        continue;
      }

      const taskThreadsById = new Map<string | null, OrchestrationThreadShell[]>();
      for (const thread of projectThreads) {
        const taskId = thread.taskContext?.taskId ?? null;
        const taskThreads = taskThreadsById.get(taskId) ?? [];
        taskThreads.push(thread);
        taskThreadsById.set(taskId, taskThreads);
      }

      for (const [taskId, taskThreads] of taskThreadsById) {
        groups.push({
          key: `${environmentId}:task:${taskId ?? project.id}`,
          kind: "task",
          title: taskTitle(snapshot.tasks ?? [], taskId),
          project: null,
          threads: sortThreads(
            taskThreads.map((thread) => ({
              ...thread,
              environmentId,
            })),
          ),
        });
      }
    }
  }

  return groups;
}

import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import { isOrdinaryProjectShell } from "@t3tools/client-runtime/state/projects";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";

export type ArchivedThreadSortOrder = "newest" | "oldest";

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly kind: "project" | "task";
  readonly project: EnvironmentProject | null;
  readonly title: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

function archiveTimestamp(thread: EnvironmentThreadShell): number {
  const timestamp = Date.parse(thread.archivedAt ?? thread.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function matchesQuery(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

function taskTitle(
  tasks: NonNullable<ArchivedSnapshotEntry["snapshot"]["tasks"]>,
  taskId: string | null,
): string {
  if (taskId === null) {
    return "Task threads";
  }
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? `Task · ${task.title}` : "Task threads";
}

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly environmentLabels: Readonly<Record<string, string>>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly sortOrder: ArchivedThreadSortOrder;
}): ReadonlyArray<ArchivedThreadGroup> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const groups: ArchivedThreadGroup[] = [];

  for (const entry of input.snapshots) {
    if (input.environmentId !== null && input.environmentId !== entry.environmentId) {
      continue;
    }

    const environmentLabel = input.environmentLabels[entry.environmentId] ?? null;
    const threadsByProjectId = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of entry.snapshot.threads) {
      if (thread.archivedAt === null) {
        continue;
      }
      const threads = threadsByProjectId.get(thread.projectId) ?? [];
      threads.push(scopeThreadShell(entry.environmentId, thread));
      threadsByProjectId.set(thread.projectId, threads);
    }

    for (const rawProject of entry.snapshot.projects) {
      const project = scopeProject(entry.environmentId, rawProject);
      const projectThreads = threadsByProjectId.get(project.id) ?? [];
      if (!isOrdinaryProjectShell(rawProject)) {
        const taskThreadsById = new Map<string | null, EnvironmentThreadShell[]>();
        for (const thread of projectThreads) {
          const taskId = thread.taskContext?.taskId ?? null;
          const taskThreads = taskThreadsById.get(taskId) ?? [];
          taskThreads.push(thread);
          taskThreadsById.set(taskId, taskThreads);
        }

        for (const [taskId, taskThreads] of taskThreadsById) {
          const title = taskTitle(entry.snapshot.tasks ?? [], taskId);
          const groupMatches =
            query.length === 0 ||
            matchesQuery(title, query) ||
            matchesQuery(environmentLabel, query);
          const matchingThreads = groupMatches
            ? taskThreads
            : taskThreads.filter(
                (thread) => matchesQuery(thread.title, query) || matchesQuery(thread.branch, query),
              );
          if (matchingThreads.length === 0) {
            continue;
          }

          const timestampOrder =
            input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
          groups.push({
            key: `${entry.environmentId}:task:${taskId ?? project.id}`,
            environmentId: entry.environmentId,
            kind: "task",
            project: null,
            title,
            threads: Arr.sort(
              matchingThreads,
              Order.mapInput(
                Order.Struct({ timestamp: timestampOrder, title: Order.String, id: Order.String }),
                (thread: EnvironmentThreadShell) => ({
                  timestamp: archiveTimestamp(thread),
                  title: thread.title,
                  id: thread.id,
                }),
              ),
            ),
          });
        }
        continue;
      }

      const groupMatches =
        query.length === 0 ||
        matchesQuery(project.title, query) ||
        matchesQuery(project.workspaceRoot, query) ||
        matchesQuery(environmentLabel, query);
      const matchingThreads = groupMatches
        ? projectThreads
        : projectThreads.filter(
            (thread) => matchesQuery(thread.title, query) || matchesQuery(thread.branch, query),
          );

      if (matchingThreads.length === 0) {
        continue;
      }

      const timestampOrder = input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
      groups.push({
        key: scopedProjectKey(project.environmentId, project.id),
        environmentId: entry.environmentId,
        kind: "project",
        project,
        title: project.title,
        threads: Arr.sort(
          matchingThreads,
          Order.mapInput(
            Order.Struct({ timestamp: timestampOrder, title: Order.String, id: Order.String }),
            (thread: EnvironmentThreadShell) => ({
              timestamp: archiveTimestamp(thread),
              title: thread.title,
              id: thread.id,
            }),
          ),
        ),
      });
    }
  }

  const timestampOrder = input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
  return Arr.sort(
    groups,
    Order.mapInput(
      Order.Struct({ timestamp: timestampOrder, title: Order.String, key: Order.String }),
      (group: ArchivedThreadGroup) => ({
        timestamp: group.threads[0] ? archiveTimestamp(group.threads[0]) : 0,
        title: group.title,
        key: group.key,
      }),
    ),
  );
}

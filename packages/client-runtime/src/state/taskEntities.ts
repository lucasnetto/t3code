import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationTask,
  ScopedTaskRef,
  TaskId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import { arrayElementsEqual, parseTaskKey, taskKey, taskRefsEqual } from "./entities.ts";
import type { EnvironmentTask } from "./models.ts";
import { scopeTask } from "./models.ts";

const EMPTY_TASKS: ReadonlyArray<OrchestrationTask> = Object.freeze([]);
const EMPTY_TASK_INDEX: ReadonlyMap<TaskId, OrchestrationTask> = new Map();

export function createEnvironmentTaskAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentTasksAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationTask> =>
        get(input.snapshotAtom(environmentId))?.tasks ?? EMPTY_TASKS,
    ).pipe(Atom.withLabel(`environment-tasks:${environmentId}`)),
  );

  const environmentTaskIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<TaskId, OrchestrationTask> => {
      const tasks = get(environmentTasksAtom(environmentId));
      return tasks.length === 0
        ? EMPTY_TASK_INDEX
        : new Map(tasks.map((task) => [task.id, task] as const));
    }).pipe(Atom.withLabel(`environment-task-index:${environmentId}`)),
  );

  const environmentTaskRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedTaskRef> = [];
    return Atom.make((get) => {
      const next = get(environmentTasksAtom(environmentId)).map((task) => ({
        environmentId,
        taskId: task.id,
      }));
      if (taskRefsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-task-refs:${environmentId}`));
  });

  const taskAtomFamily = Atom.family((key: string) => {
    const ref = parseTaskKey(key);
    let previousSource: OrchestrationTask | null = null;
    let previousValue: EnvironmentTask | null = null;
    return Atom.make((get) => {
      const source = get(environmentTaskIndexAtom(ref.environmentId)).get(ref.taskId) ?? null;
      if (source === previousSource) return previousValue;
      previousSource = source;
      previousValue = source === null ? null : scopeTask(ref.environmentId, source);
      return previousValue;
    }).pipe(Atom.withLabel(`environment-task:${key}`));
  });

  let previousTaskRefs: ReadonlyArray<ScopedTaskRef> = [];
  const taskRefsAtom = Atom.make((get) => {
    const refs: ScopedTaskRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentTaskRefsAtom(environmentId)));
    }
    if (taskRefsEqual(previousTaskRefs, refs)) return previousTaskRefs;
    previousTaskRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-task-refs"));

  let previousTasks: ReadonlyArray<EnvironmentTask> = [];
  const tasksAtom = Atom.make((get) => {
    const next = get(taskRefsAtom).flatMap((ref) => {
      const task = get(taskAtomFamily(taskKey(ref)));
      return task === null ? [] : [task];
    });
    if (arrayElementsEqual(previousTasks, next)) return previousTasks;
    previousTasks = next;
    return previousTasks;
  }).pipe(Atom.withLabel("environment-task-list"));

  return {
    environmentTasksAtom,
    environmentTaskIndexAtom,
    environmentTaskRefsAtom,
    taskRefsAtom,
    tasksAtom,
    taskAtom: (ref: ScopedTaskRef) => taskAtomFamily(taskKey(ref)),
  };
}

import {
  EnvironmentId,
  ProjectId,
  TaskId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentTaskAtoms } from "./taskEntities.ts";

const environmentId = EnvironmentId.make("environment-1");
const taskId = TaskId.make("task-1");
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  tasks: [
    {
      id: taskId,
      title: "Coordinate release",
      status: "active",
      rootPath: "/tmp/t3/tasks/task-1",
      workspaceProjectId: ProjectId.make("project-task-1"),
      approvedProjectIds: [ProjectId.make("project-api")],
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: "2026-07-23T12:00:00.000Z",
      completedAt: null,
    },
  ],
  projects: [],
  threads: [],
  updatedAt: "2026-07-23T12:00:00.000Z",
};

describe("environment task projections", () => {
  it("scopes task rows and references to their environment", () => {
    const catalogValueAtom = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Environment",
              httpBaseUrl: "https://example.test",
              wsBaseUrl: "wss://example.test",
            }),
            profile: Option.none(),
          },
        ],
      ]),
    });
    const snapshotAtom = Atom.make<OrchestrationShellSnapshot | null>(snapshot);
    const atoms = createEnvironmentTaskAtoms({
      catalogValueAtom,
      snapshotAtom: () => snapshotAtom,
    });
    const registry = AtomRegistry.make();

    expect(registry.get(atoms.environmentTaskRefsAtom(environmentId))).toEqual([
      { environmentId, taskId },
    ]);
    expect(registry.get(atoms.taskAtom({ environmentId, taskId }))).toMatchObject({
      id: taskId,
      environmentId,
      title: "Coordinate release",
    });
  });
});

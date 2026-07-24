import { EnvironmentId, ProjectId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { threadProjectRef } from "./threadProject";

const environmentId = EnvironmentId.make("environment-1");
const visibleProjectId = ProjectId.make("project-visible");
const taskWorkspaceProjectId = ProjectId.make("project-task-workspace");
const createdAt = "2026-07-24T12:00:00.000Z";
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [
    {
      id: visibleProjectId,
      title: "Repository",
      workspaceRoot: "/tmp/repository",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
      visibility: "visible",
    },
    {
      id: taskWorkspaceProjectId,
      title: "Task workspace",
      workspaceRoot: "/tmp/task",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
      visibility: "internal-task",
    },
  ],
  threads: [],
  updatedAt: createdAt,
};

function makeProjectAtoms() {
  const catalogValueAtom = Atom.make({
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
  return createEnvironmentProjectAtoms({
    catalogValueAtom,
    snapshotAtom: () => snapshotAtom,
  });
}

describe("thread workspace project resolution", () => {
  it("keeps a task workspace hidden from collections while resolving its task thread", () => {
    const atoms = makeProjectAtoms();
    const registry = AtomRegistry.make();
    const taskThread = {
      environmentId,
      projectId: taskWorkspaceProjectId,
    };

    expect(registry.get(atoms.projectsAtom).map((project) => project.id)).toEqual([
      visibleProjectId,
    ]);
    expect(registry.get(atoms.projectAtom(threadProjectRef(taskThread)))).toBeNull();
    expect(
      registry.get(atoms.projectIncludingInternalAtom(threadProjectRef(taskThread))),
    ).toMatchObject({
      id: taskWorkspaceProjectId,
      workspaceRoot: "/tmp/task",
      visibility: "internal-task",
    });
  });

  it("keeps standalone thread project resolution unchanged", () => {
    const atoms = makeProjectAtoms();
    const registry = AtomRegistry.make();
    const standaloneThread = {
      environmentId,
      projectId: visibleProjectId,
    };
    const ref = threadProjectRef(standaloneThread);

    expect(registry.get(atoms.projectIncludingInternalAtom(ref))).toEqual(
      registry.get(atoms.projectAtom(ref)),
    );
  });
});

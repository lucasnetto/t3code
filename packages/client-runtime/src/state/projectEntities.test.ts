import { EnvironmentId, ProjectId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";

const environmentId = EnvironmentId.make("environment-1");
const createdAt = "2026-07-23T12:00:00.000Z";
const visibleProjectId = ProjectId.make("project-visible");
const internalProjectId = ProjectId.make("project-task-internal");

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [
    {
      id: visibleProjectId,
      title: "Visible repository",
      workspaceRoot: "/tmp/visible",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
      visibility: "visible",
    },
    {
      id: internalProjectId,
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

describe("environment project projections", () => {
  it("hides internal task projects from collections while keeping direct lookup available", () => {
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
    const atoms = createEnvironmentProjectAtoms({
      catalogValueAtom,
      snapshotAtom: () => snapshotAtom,
    });
    const registry = AtomRegistry.make();

    expect(registry.get(atoms.environmentProjectRefsAtom(environmentId))).toEqual([
      { environmentId, projectId: visibleProjectId },
    ]);
    expect(
      registry.get(
        atoms.projectAtom({
          environmentId,
          projectId: internalProjectId,
        }),
      ),
    ).toMatchObject({
      environmentId,
      id: internalProjectId,
      workspaceRoot: "/tmp/task",
      visibility: "internal-task",
    });
  });
});

import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type ApproveTaskRepositoryInput,
  type UpdateTaskInput,
  approveTaskRepository,
  updateTask,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  ApproveTaskRepositoryInput,
  UpdateTaskInput,
} from "../operations/commands.ts";

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { taskId: string } }) =>
      JSON.stringify([environmentId, input.taskId]),
  };

  return {
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:update",
      execute: (input: UpdateTaskInput) => updateTask(input),
      scheduler,
      concurrency,
    }),
    approveRepository: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:approve-repository",
      execute: (input: ApproveTaskRepositoryInput) => approveTaskRepository(input),
      scheduler,
      concurrency,
    }),
  };
}

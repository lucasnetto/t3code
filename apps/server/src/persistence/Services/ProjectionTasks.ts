import { IsoDateTime, OrchestrationTaskStatus, ProjectId, TaskId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTask = Schema.Struct({
  taskId: TaskId,
  title: Schema.String,
  status: OrchestrationTaskStatus,
  rootPath: Schema.String,
  workspaceProjectId: ProjectId,
  approvedProjectIds: Schema.Array(ProjectId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTask = typeof ProjectionTask.Type;

export const GetProjectionTaskInput = Schema.Struct({
  taskId: TaskId,
});
export type GetProjectionTaskInput = typeof GetProjectionTaskInput.Type;

export interface ProjectionTaskRepositoryShape {
  readonly upsert: (task: ProjectionTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionTaskInput,
  ) => Effect.Effect<Option.Option<ProjectionTask>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionTask>, ProjectionRepositoryError>;
}

export class ProjectionTaskRepository extends Context.Service<
  ProjectionTaskRepository,
  ProjectionTaskRepositoryShape
>()("t3/persistence/Services/ProjectionTasks/ProjectionTaskRepository") {}

import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionTaskInput,
  ProjectionTask,
  ProjectionTaskRepository,
  type ProjectionTaskRepositoryShape,
} from "../Services/ProjectionTasks.ts";

const ProjectionTaskDbRow = ProjectionTask.mapFields(
  Struct.assign({
    approvedProjectIds: Schema.fromJsonString(Schema.Array(ProjectId)),
  }),
);

const makeProjectionTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTaskRow = SqlSchema.void({
    Request: ProjectionTask,
    execute: (row) =>
      sql`
        INSERT INTO projection_tasks (
          task_id,
          title,
          status,
          root_path,
          workspace_project_id,
          approved_project_ids_json,
          created_at,
          updated_at,
          completed_at
        )
        VALUES (
          ${row.taskId},
          ${row.title},
          ${row.status},
          ${row.rootPath},
          ${row.workspaceProjectId},
          ${JSON.stringify(row.approvedProjectIds)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.completedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          root_path = excluded.root_path,
          workspace_project_id = excluded.workspace_project_id,
          approved_project_ids_json = excluded.approved_project_ids_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at
      `,
  });

  const getProjectionTaskRow = SqlSchema.findOneOption({
    Request: GetProjectionTaskInput,
    Result: ProjectionTaskDbRow,
    execute: ({ taskId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          title,
          status,
          root_path AS "rootPath",
          workspace_project_id AS "workspaceProjectId",
          approved_project_ids_json AS "approvedProjectIds",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const listProjectionTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTaskDbRow,
    execute: () =>
      sql`
        SELECT
          task_id AS "taskId",
          title,
          status,
          root_path AS "rootPath",
          workspace_project_id AS "workspaceProjectId",
          approved_project_ids_json AS "approvedProjectIds",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_tasks
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const upsert: ProjectionTaskRepositoryShape["upsert"] = (task) =>
    upsertProjectionTaskRow(task).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
    );

  const getById: ProjectionTaskRepositoryShape["getById"] = (input) =>
    getProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
    );

  const listAll: ProjectionTaskRepositoryShape["listAll"] = () =>
    listProjectionTaskRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listAll:query")),
    );

  return {
    upsert,
    getById,
    listAll,
  } satisfies ProjectionTaskRepositoryShape;
});

export const ProjectionTaskRepositoryLive = Layer.effect(
  ProjectionTaskRepository,
  makeProjectionTaskRepository,
);

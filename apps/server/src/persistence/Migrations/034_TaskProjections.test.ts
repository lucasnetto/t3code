import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_TaskProjections", (it) => {
  it.effect("adds task projections and backward-compatible task context columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-existing',
          'Existing project',
          '/tmp/existing',
          NULL,
          '[]',
          '2026-07-23T12:00:00.000Z',
          '2026-07-23T12:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const taskColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_tasks)
      `;
      assert.ok(taskColumns.some((column) => column.name === "workspace_project_id"));
      assert.ok(taskColumns.some((column) => column.name === "approved_project_ids_json"));

      const projectRows = yield* sql<{ readonly visibility: string }>`
        SELECT visibility
        FROM projection_projects
        WHERE project_id = 'project-existing'
      `;
      assert.strictEqual(projectRows[0]?.visibility, "visible");

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "task_id"));
      assert.ok(threadColumns.some((column) => column.name === "created_by_kind"));
      assert.ok(threadColumns.some((column) => column.name === "created_by_thread_id"));
      assert.ok(threadColumns.some((column) => column.name === "created_by_turn_id"));
    }),
  );
});

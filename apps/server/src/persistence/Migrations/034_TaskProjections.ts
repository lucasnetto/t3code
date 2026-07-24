import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      root_path TEXT NOT NULL,
      workspace_project_id TEXT NOT NULL,
      approved_project_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_tasks_root_path
    ON projection_tasks(root_path)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_tasks_status_updated
    ON projection_tasks(status, updated_at)
  `;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "visibility")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'visible'
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "task_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_id TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "created_by_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN created_by_kind TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "created_by_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN created_by_thread_id TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "created_by_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN created_by_turn_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_task_created
    ON projection_threads(task_id, created_at)
  `;
});

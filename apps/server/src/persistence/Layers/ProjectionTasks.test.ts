import { ProjectId, TaskId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { ProjectionTaskRepositoryLive } from "./ProjectionTasks.ts";
import { ProjectionTaskRepository } from "../Services/ProjectionTasks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  ProjectionTaskRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionTaskRepository", (it) => {
  it.effect("round-trips task rows and approved project order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTaskRepository;
      const taskId = TaskId.make("task-1");
      const approvedProjectIds = [ProjectId.make("project-api"), ProjectId.make("project-web")];

      yield* repository.upsert({
        taskId,
        title: "Ship multi-repo feature",
        status: "active",
        rootPath: "/tmp/t3/tasks/task-1",
        workspaceProjectId: ProjectId.make("project-task-1"),
        approvedProjectIds,
        createdAt: "2026-07-23T12:00:00.000Z",
        updatedAt: "2026-07-23T12:00:00.000Z",
        completedAt: null,
      });

      const result = yield* repository.getById({ taskId });
      assert.ok(Option.isSome(result));
      assert.deepStrictEqual(result.value.approvedProjectIds, approvedProjectIds);
      assert.strictEqual(result.value.rootPath, "/tmp/t3/tasks/task-1");
    }),
  );

  it.effect("classifies malformed stored task json as a decode error", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTaskRepository;
      const sql = yield* SqlClient.SqlClient;
      const taskId = TaskId.make("task-invalid-approved-projects");
      const now = "2026-07-23T12:00:00.000Z";

      yield* sql`
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
          ${taskId},
          ${"Malformed task"},
          ${"active"},
          ${"/tmp/t3/tasks/task-invalid-approved-projects"},
          ${ProjectId.make("project-task-invalid-approved-projects")},
          ${"{"},
          ${now},
          ${now},
          ${null}
        )
      `;

      const getResult = yield* Effect.result(repository.getById({ taskId }));
      assert.equal(getResult._tag, "Failure");
      if (getResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(getResult.failure));
        assert.equal(getResult.failure.operation, "ProjectionTaskRepository.getById:decodeRow");
      }

      const listResult = yield* Effect.result(repository.listAll());
      assert.equal(listResult._tag, "Failure");
      if (listResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(listResult.failure));
        assert.equal(listResult.failure.operation, "ProjectionTaskRepository.listAll:decodeRows");
      }
    }),
  );
});

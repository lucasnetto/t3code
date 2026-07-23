import { ProjectId, TaskId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTaskRepositoryLive } from "./ProjectionTasks.ts";
import { ProjectionTaskRepository } from "../Services/ProjectionTasks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

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
});

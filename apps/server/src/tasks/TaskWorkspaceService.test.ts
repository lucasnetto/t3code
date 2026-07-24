import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { TaskWorkspaceService, TaskWorkspaceServiceLive } from "./TaskWorkspaceService.ts";

const layer = it.layer(
  TaskWorkspaceServiceLive.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-task-workspace-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("TaskWorkspaceService", (it) => {
  it.effect("keeps generated workspace paths lexically contained", () =>
    Effect.gen(function* () {
      const service = yield* TaskWorkspaceService;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const taskRoot = service.newTaskRoot(TaskId.make("../task/outside"));
      const tasksRoot = path.join(config.worktreesDir, "tasks");
      const taskRelativePath = path.relative(tasksRoot, taskRoot);

      assert.equal(taskRelativePath.startsWith("..") || path.isAbsolute(taskRelativePath), false);

      const managedWorktreePath = service.managedWorktreePath({
        taskRoot,
        threadId: ThreadId.make("../../thread/outside"),
        projectTitle: "../../../../repository",
      });
      const managedRelativePath = path.relative(taskRoot, managedWorktreePath);

      assert.equal(
        managedRelativePath.startsWith("..") || path.isAbsolute(managedRelativePath),
        false,
      );
      assert.equal(managedRelativePath.startsWith(`worktrees${path.sep}`), true);
    }),
  );

  it.effect("encodes every identifier into a distinct path-safe segment", () =>
    Effect.gen(function* () {
      const service = yield* TaskWorkspaceService;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const tasksRoot = path.join(config.worktreesDir, "tasks");
      const identifiers = ["/", "id-Lw", "CON", "NUL", "task.", "thread.."] as const;
      const taskSegments = identifiers.map(
        (identifier) =>
          [
            identifier,
            path.relative(tasksRoot, service.newTaskRoot(TaskId.make(identifier))),
          ] as const,
      );

      assert.equal(new Set(taskSegments.map(([, segment]) => segment)).size, identifiers.length);

      taskSegments.forEach(([identifier, taskSegment]) => {
        const expectedSegment = `id-${Encoding.encodeBase64Url(identifier)}`;

        assert.equal(taskSegment, expectedSegment);
        assert.match(taskSegment, /^id-[A-Za-z0-9_-]+$/);
        assert.equal(taskSegment.endsWith("."), false);
      });

      const taskRoot = service.newTaskRoot(TaskId.make("task-1"));
      const threadPaths = identifiers.map(
        (identifier) =>
          [
            identifier,
            service.managedWorktreePath({
              taskRoot,
              threadId: ThreadId.make(identifier),
              projectTitle: "Repository",
            }),
          ] as const,
      );

      assert.equal(
        new Set(threadPaths.map(([, threadPath]) => threadPath)).size,
        identifiers.length,
      );
      threadPaths.forEach(([identifier, threadPath]) => {
        assert.equal(
          path.basename(threadPath),
          `id-${Encoding.encodeBase64Url(identifier)}-repository`,
        );
      });
    }),
  );

  it.effect("creates stable task paths and atomically generated context", () =>
    Effect.gen(function* () {
      const service = yield* TaskWorkspaceService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const taskId = TaskId.make("task-1");
      const rootPath = service.newTaskRoot(taskId);

      assert.equal(rootPath, path.join(config.worktreesDir, "tasks", "id-dGFzay0x"));
      assert.equal(
        service.managedWorktreePath({
          taskRoot: rootPath,
          threadId: ThreadId.make("thread-1"),
          projectTitle: "Tubarão API",
        }),
        path.join(rootPath, "worktrees", "id-dGhyZWFkLTE-tubarao-api"),
      );

      yield* service.prepare({
        task: {
          id: taskId,
          title: "Coordinate release",
          status: "active",
          rootPath,
          workspaceProjectId: ProjectId.make("project-task-1"),
          approvedProjectIds: [ProjectId.make("project-api")],
          createdAt: "2026-07-23T12:00:00.000Z",
          updatedAt: "2026-07-23T12:00:00.000Z",
          completedAt: null,
        },
        projects: [
          {
            id: ProjectId.make("project-api"),
            title: "API",
            workspaceRoot: "/tmp/api",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-07-23T12:00:00.000Z",
            updatedAt: "2026-07-23T12:00:00.000Z",
          },
        ],
        threads: [],
      });

      assert.equal(yield* fileSystem.exists(path.join(rootPath, "worktrees")), true);
      const context = yield* fileSystem.readFileString(path.join(rootPath, "TASK.md"));
      assert.match(context, /# Coordinate release/);
      assert.match(context, /API \(`project-api`\)/);
      assert.match(context, /No durable threads yet/);
    }),
  );

  it.effect("refreshes an existing persisted root without relocating it", () =>
    Effect.gen(function* () {
      const service = yield* TaskWorkspaceService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const persistedRoot = path.join(config.baseDir, "previous-worktree-base", "task-older");

      yield* service.prepare({
        task: {
          id: TaskId.make("task-older"),
          title: "Existing task",
          status: "active",
          rootPath: persistedRoot,
          workspaceProjectId: ProjectId.make("project-task-older"),
          approvedProjectIds: [],
          createdAt: "2026-07-20T12:00:00.000Z",
          updatedAt: "2026-07-20T12:00:00.000Z",
          completedAt: null,
        },
        projects: [],
        threads: [],
      });

      assert.equal(yield* fileSystem.exists(path.join(persistedRoot, "TASK.md")), true);
      assert.notEqual(persistedRoot, service.newTaskRoot(TaskId.make("task-older")));
    }),
  );
});

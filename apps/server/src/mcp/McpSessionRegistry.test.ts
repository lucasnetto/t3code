import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

const taskThreadQueryLayer = (createdBy: "user" | "agent") =>
  Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some({
          id: threadId,
          projectId: ProjectId.make("project-task"),
          title: "Task thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-07-23T12:00:00.000Z",
          updatedAt: "2026-07-23T12:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          taskContext: {
            taskId: TaskId.make("task-1"),
            createdBy:
              createdBy === "user"
                ? { kind: "user" as const }
                : {
                    kind: "agent" as const,
                    threadId: ThreadId.make("thread-parent"),
                    turnId: TurnId.make("turn-parent"),
                  },
          },
        }),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials after inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("grants task tools only to user-created task threads", () =>
  Effect.gen(function* () {
    const issueCapabilities = (createdBy: "user" | "agent") =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry(() => 1_000).pipe(taskThreadQueryLayer(createdBy));
        const issued = yield* registry.issue({
          threadId: ThreadId.make(`thread-${createdBy}`),
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
        return (yield* registry.resolve(token))?.capabilities;
      });

    expect(Array.from((yield* issueCapabilities("user")) ?? [])).toEqual(["preview", "task"]);
    expect(Array.from((yield* issueCapabilities("agent")) ?? [])).toEqual(["preview"]);
  }),
);

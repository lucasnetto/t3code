import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { ProviderInstanceId } from "@t3tools/contracts";
import type {
  CursorSdkAgent,
  CursorSdkClientShape,
  CursorSdkRun,
  CursorSdkStore,
} from "../provider/Services/CursorSdkClient.ts";
import { makeCursorSdkTextGeneration } from "./CursorSdkTextGeneration.ts";

const store: CursorSdkStore = {
  value: {} as CursorSdkStore["value"],
  dispose: async () => {},
};

function makeClient(input: {
  readonly result: string;
  readonly onCreate?: (options: unknown) => void;
  readonly onDispose?: () => void;
  readonly onAgent?: (agent: CursorSdkAgent) => void;
}): CursorSdkClientShape {
  const run = {
    id: "text-run",
    agentId: "text-agent",
    status: "finished",
    supports: () => false,
    unsupportedReason: () => "unsupported by test double",
    stream: async function* () {},
    conversation: async () => [],
    wait: async () => ({ id: "text-run", status: "finished", result: input.result }),
    cancel: async () => {},
    onDidChangeStatus: () => () => {},
  } as CursorSdkRun;
  const agent: CursorSdkAgent = {
    agentId: "text-agent",
    model: undefined,
    send: async () => run,
    close: () => {},
    reload: async () => {},
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from([]),
    [Symbol.asyncDispose]: async () => input.onDispose?.(),
  };
  input.onAgent?.(agent);
  return {
    openStore: async () => store,
    createAgent: async (options) => {
      input.onCreate?.(options);
      return agent;
    },
    resumeAgent: async () => agent,
    me: async () => ({ apiKeyName: "Test", createdAt: "2026-01-01T00:00:00.000Z" }),
    listModels: async () => [],
    listRuns: async () => [],
    getRun: async () => run,
  };
}

const modelSelection = {
  instanceId: ProviderInstanceId.make("cursorSdk"),
  model: "composer-2",
  options: [{ id: "thinking", value: "high" }],
} as const;

describe("CursorSdkTextGeneration", () => {
  it.effect("uses a short-lived agent and disposes it after structured generation", () => {
    const createOptions: unknown[] = [];
    let disposeCalls = 0;
    return Effect.gen(function* () {
      const service = yield* makeCursorSdkTextGeneration({
        apiKey: "test-key",
        client: makeClient({
          result: '{"title":"  Cursor SDK support!  "}',
          onCreate: (options) => createOptions.push(options),
          onDispose: () => {
            disposeCalls += 1;
          },
        }),
        getStore: () => Effect.succeed(store),
      });
      const result = yield* service.generateThreadTitle({
        cwd: "/workspace",
        message: "Add Cursor SDK support",
        modelSelection,
      });

      expect(result).toEqual({ title: "Cursor SDK support!" });
      expect(createOptions).toEqual([
        expect.objectContaining({
          apiKey: "test-key",
          model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
          local: expect.objectContaining({ cwd: "/workspace", autoReview: false }),
          mode: "agent",
        }),
      ]);
      expect(disposeCalls).toBe(1);
    });
  });

  it.effect("fails before creating an agent when CURSOR_API_KEY is absent", () =>
    Effect.gen(function* () {
      let createCalls = 0;
      const service = yield* makeCursorSdkTextGeneration({
        apiKey: undefined,
        client: makeClient({
          result: "{}",
          onCreate: () => {
            createCalls += 1;
          },
        }),
        getStore: () => Effect.succeed(store),
      });
      const exit = yield* Effect.exit(
        service.generateThreadTitle({
          cwd: "/workspace",
          message: "Add Cursor SDK support",
          modelSelection,
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(createCalls).toBe(0);
    }),
  );

  it.effect("times out a hung agent acquisition and disposes an eventual late agent", () => {
    let agent: CursorSdkAgent | undefined;
    let releaseCreate!: (agent: CursorSdkAgent) => void;
    let disposeCalls = 0;
    const createPromise = new Promise<CursorSdkAgent>((resolve) => {
      releaseCreate = resolve;
    });
    const baseClient = makeClient({
      result: '{"title":"late"}',
      onAgent: (created) => {
        agent = created;
      },
      onDispose: () => {
        disposeCalls += 1;
      },
    });

    return Effect.gen(function* () {
      const service = yield* makeCursorSdkTextGeneration({
        apiKey: "test-key",
        client: { ...baseClient, createAgent: () => createPromise },
        getStore: () => Effect.succeed(store),
      });
      const generationFiber = yield* service
        .generateThreadTitle({
          cwd: "/workspace",
          message: "Add Cursor SDK support",
          modelSelection,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("180 seconds");
      const exit = yield* Fiber.await(generationFiber);

      expect(exit._tag).toBe("Failure");
      expect(disposeCalls).toBe(0);
      releaseCreate(agent!);
      yield* Effect.yieldNow;
      expect(disposeCalls).toBe(1);
    });
  });
});

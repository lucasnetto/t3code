import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";

import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import type {
  CursorSdkAgent,
  CursorSdkClientShape,
  CursorSdkConversationTurn,
  CursorSdkDelta,
  CursorSdkRun,
  CursorSdkRunResult,
  CursorSdkStore,
} from "../Services/CursorSdkClient.ts";
import { makeCursorSdkAdapter } from "./CursorSdkAdapter.ts";

const cursorSdk = ProviderDriverKind.make("cursorSdk");
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function latch<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeRun(input: {
  readonly id: string;
  readonly wait: () => Promise<CursorSdkRunResult>;
  readonly cancel?: () => Promise<void>;
}): CursorSdkRun {
  return {
    id: input.id,
    agentId: "agent-1",
    status: "running",
    supports: () => false,
    unsupportedReason: () => "unsupported by test double",
    stream: async function* () {},
    conversation: async () => [],
    wait: input.wait,
    cancel: input.cancel ?? (async () => {}),
    onDidChangeStatus: () => () => {},
  } as CursorSdkRun;
}

function makeAgent(send: CursorSdkAgent["send"], onDispose = () => {}): CursorSdkAgent {
  return {
    agentId: "agent-1",
    model: undefined,
    send,
    close: () => {},
    reload: async () => {},
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from([]),
    [Symbol.asyncDispose]: async () => onDispose(),
  };
}

function makeClient(agent: CursorSdkAgent): CursorSdkClientShape {
  const store: CursorSdkStore = {
    value: {} as CursorSdkStore["value"],
    dispose: async () => {},
  };
  return {
    openStore: async () => store,
    createAgent: async () => agent,
    resumeAgent: async () => agent,
    me: async () => ({ apiKeyName: "Test", createdAt: "2026-01-01T00:00:00.000Z" }),
    listModels: async () => [],
    listRuns: async () => [],
    getRun: async () => Promise.reject(new Error("unused")),
  };
}

type AdapterTestServices =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | ServerConfig;

const adapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cursor-sdk-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const withAdapterServices = <A, E>(effect: Effect.Effect<A, E, AdapterTestServices>) =>
  Effect.scoped(effect.pipe(Effect.provide(adapterTestLayer)));

describe("CursorSdkAdapter", () => {
  it.effect("disposes active session agents before their durable store", () =>
    withAdapterServices(
      Effect.gen(function* () {
        const disposalOrder: string[] = [];
        const agent = makeAgent(
          async () =>
            makeRun({ id: "unused", wait: async () => ({ id: "unused", status: "finished" }) }),
          () => disposalOrder.push("agent"),
        );
        const baseClient = makeClient(agent);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* makeCursorSdkAdapter({
              environment: { CURSOR_API_KEY: "test-key" },
              client: {
                ...baseClient,
                openStore: async () => ({
                  value: {} as CursorSdkStore["value"],
                  dispose: async () => {
                    disposalOrder.push("store");
                  },
                }),
              },
            });
            yield* adapter.startSession({
              provider: cursorSdk,
              threadId: ThreadId.make("scope-disposal-order"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
          }),
        );

        expect(disposalOrder).toEqual(["agent", "store"]);
      }),
    ),
  );

  it.effect("rejects runtime modes that the SDK provider does not advertise", () => {
    let createCalls = 0;
    const agent = makeAgent(async () =>
      makeRun({ id: "unused", wait: async () => ({ id: "unused", status: "finished" }) }),
    );

    return withAdapterServices(
      Effect.gen(function* () {
        const client = makeClient(agent);
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: {
            ...client,
            createAgent: async () => {
              createCalls += 1;
              return agent;
            },
          },
        });
        const exit = yield* Effect.exit(
          adapter.startSession({
            provider: cursorSdk,
            threadId: ThreadId.make("unsupported-mode"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          }),
        );

        expect(exit._tag).toBe("Failure");
        expect(createCalls).toBe(0);
      }),
    );
  });

  it.effect("remembers an interrupt requested before the SDK returns its run handle", () => {
    const sendStarted = latch<void>();
    const releaseSend = latch<CursorSdkRun>();
    let cancelCalls = 0;
    const cancelledResult: CursorSdkRunResult = { id: "run-1", status: "cancelled" };
    const run = makeRun({
      id: "run-1",
      wait: async () => cancelledResult,
      cancel: async () => {
        cancelCalls += 1;
      },
    });
    const agent = makeAgent(async () => {
      sendStarted.resolve();
      return releaseSend.promise;
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("interrupt-before-handle");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "hello" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => sendStarted.promise);
        yield* adapter.interruptTurn(threadId);
        releaseSend.resolve(run);
        const result = yield* Fiber.join(sendFiber);

        expect(result.resumeCursor).toMatchObject({ runId: "run-1" });
        expect(cancelCalls).toBe(1);
      }),
    );
  });

  it.effect("surfaces cancellation failure and preserves a later finished result", () => {
    const waitStarted = latch<void>();
    const waitResult = latch<CursorSdkRunResult>();
    const run = makeRun({
      id: "cancel-failure-finished",
      wait: async () => {
        waitStarted.resolve();
        return waitResult.promise;
      },
      cancel: async () => {
        throw new Error("cancel failed");
      },
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(makeAgent(async () => run)),
        });
        const threadId = ThreadId.make("cancel-failure-finished");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const terminalEvent = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "keep running" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitStarted.promise);

        const interruptExit = yield* Effect.exit(adapter.interruptTurn(threadId));
        expect(interruptExit._tag).toBe("Failure");

        waitResult.resolve({ id: run.id, status: "finished", result: "completed anyway" });
        yield* Fiber.join(sendFiber);
        expect([...(yield* Fiber.join(terminalEvent))][0]?.payload).toMatchObject({
          state: "completed",
        });
      }),
    );
  });

  it.effect("reports an error exit when pre-handle cancellation later fails", () => {
    const sendStarted = latch<void>();
    const releaseSend = latch<CursorSdkRun>();
    const run = makeRun({
      id: "cancel-fails",
      wait: async () => ({ id: "cancel-fails", status: "cancelled" }),
      cancel: async () => {
        throw new Error("cancel failed");
      },
    });
    const agent = makeAgent(async () => {
      sendStarted.resolve();
      return releaseSend.promise;
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("pre-handle-cancel-fails");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const exitEvents = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.filter((event) => event.type === "session.exited"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "cancel me" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => sendStarted.promise);
        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        releaseSend.resolve(run);
        yield* Fiber.join(stopFiber);
        yield* Fiber.await(sendFiber);

        expect([...(yield* Fiber.join(exitEvents))][0]?.payload).toMatchObject({
          exitKind: "error",
          reason: "Cursor SDK run cancellation failed.",
        });
      }),
    );
  });

  it.effect("serializes concurrent sends for one durable agent", () => {
    const firstWait = latch<CursorSdkRunResult>();
    const firstSendStarted = latch<void>();
    const sendCalls: string[] = [];
    const agent = makeAgent(async (message) => {
      const text = typeof message === "string" ? message : message.text;
      sendCalls.push(text);
      if (sendCalls.length === 1) {
        firstSendStarted.resolve();
        return makeRun({ id: "run-1", wait: () => firstWait.promise });
      }
      return makeRun({
        id: "run-2",
        wait: async () => ({ id: "run-2", status: "finished", result: "done" }),
      });
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("serialized-sends");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const firstFiber = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => firstSendStarted.promise);
        const secondFiber = yield* adapter
          .sendTurn({ threadId, input: "second" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(sendCalls).toEqual(["first"]);

        firstWait.resolve({ id: "run-1", status: "finished", result: "done" });
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        expect(sendCalls).toEqual(["first", "second"]);
      }),
    );
  });

  it.effect("creates, resumes, replaces, stops, and disposes session agents exactly once", () => {
    const disposed: string[] = [];
    const createOptions: unknown[] = [];
    const resumeCalls: Array<{ agentId: string; options: unknown }> = [];
    const createdAgent = {
      ...makeAgent(
        async () =>
          makeRun({
            id: "created-run",
            wait: async () => ({ id: "created-run", status: "finished" }),
          }),
        () => disposed.push("created"),
      ),
      agentId: "created-agent",
    };
    const resumedAgent = {
      ...makeAgent(
        async () =>
          makeRun({
            id: "resumed-run",
            wait: async () => ({ id: "resumed-run", status: "finished" }),
          }),
        () => disposed.push("resumed"),
      ),
      agentId: "resumed-agent",
    };

    return withAdapterServices(
      Effect.gen(function* () {
        const baseClient = makeClient(createdAgent);
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: {
            ...baseClient,
            createAgent: async (options) => {
              createOptions.push(options);
              return createdAgent;
            },
            resumeAgent: async (agentId, options) => {
              resumeCalls.push({ agentId, options });
              return resumedAgent;
            },
          },
        });
        const threadId = ThreadId.make("resume-and-replace");
        const created = yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        expect(createOptions).toHaveLength(1);
        expect(createOptions[0]).toMatchObject({
          mode: "agent",
          local: { cwd: process.cwd(), autoReview: false },
        });
        expect(created.resumeCursor).toMatchObject({
          schemaVersion: 1,
          provider: "cursorSdk",
          agentId: "created-agent",
        });
        expect(created.runtimeMode).toBe("full-access");

        const resumed = yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "auto-review",
          resumeCursor: created.resumeCursor,
        });
        expect(resumeCalls).toHaveLength(1);
        expect(resumeCalls[0]?.agentId).toBe("created-agent");
        expect(resumeCalls[0]?.options).toMatchObject({
          local: { cwd: process.cwd(), autoReview: true },
        });
        expect(disposed).toEqual(["created"]);
        expect(resumed.resumeCursor).toMatchObject({ agentId: "resumed-agent" });
        expect(resumed.runtimeMode).toBe("auto-review");

        yield* adapter.stopSession(threadId);
        yield* adapter.stopSession(threadId);
        expect(disposed).toEqual(["created", "resumed"]);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    );
  });

  it.effect("disposes an acquired agent when session creation is interrupted", () => {
    const createStarted = latch<void>();
    const releaseCreate = latch<CursorSdkAgent>();
    const disposed = latch<void>();
    let disposeCalls = 0;
    const agent = makeAgent(
      async () =>
        makeRun({ id: "unused", wait: async () => ({ id: "unused", status: "finished" }) }),
      () => {
        disposeCalls += 1;
        disposed.resolve();
      },
    );

    return withAdapterServices(
      Effect.gen(function* () {
        const client = makeClient(agent);
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: {
            ...client,
            createAgent: async () => {
              createStarted.resolve();
              return releaseCreate.promise;
            },
          },
        });
        const startFiber = yield* adapter
          .startSession({
            provider: cursorSdk,
            threadId: ThreadId.make("interrupted-create"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => createStarted.promise);
        const interruptFiber = yield* Fiber.interrupt(startFiber).pipe(Effect.forkChild);
        yield* Fiber.join(interruptFiber);
        expect(disposeCalls).toBe(0);
        releaseCreate.resolve(agent);
        yield* Effect.promise(() => disposed.promise);

        expect(disposeCalls).toBe(1);
      }),
    );
  });

  it.effect("lets stopSession cancel and clean up an in-flight session creation", () => {
    const createStarted = latch<void>();
    const releaseCreate = latch<CursorSdkAgent>();
    const disposed = latch<void>();
    let disposeCalls = 0;
    const agent = makeAgent(
      async () =>
        makeRun({ id: "unused", wait: async () => ({ id: "unused", status: "finished" }) }),
      () => {
        disposeCalls += 1;
        disposed.resolve();
      },
    );

    return withAdapterServices(
      Effect.gen(function* () {
        const client = makeClient(agent);
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: {
            ...client,
            createAgent: async () => {
              createStarted.resolve();
              return releaseCreate.promise;
            },
          },
        });
        const threadId = ThreadId.make("stop-during-create");
        const startFiber = yield* adapter
          .startSession({
            provider: cursorSdk,
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => createStarted.promise);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect((yield* adapter.listSessions())[0]?.status).toBe("connecting");

        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Fiber.join(stopFiber);
        const startExit = yield* Fiber.await(startFiber);

        expect(startExit._tag).toBe("Failure");
        expect(disposeCalls).toBe(0);
        releaseCreate.resolve(agent);
        yield* Effect.promise(() => disposed.promise);
        expect(disposeCalls).toBe(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    );
  });

  it.effect("emits ordered item lifecycles and terminalizes every started item", () => {
    const updates: CursorSdkDelta[] = [
      { type: "text-delta", text: "hello" } as CursorSdkDelta,
      { type: "thinking-delta", text: "reasoning" } as CursorSdkDelta,
      {
        type: "tool-call-completed",
        callId: "tool-1",
        modelCallId: "model-call-1",
        toolCall: {
          type: "shell",
          args: { command: "pwd" },
          result: { status: "success", value: "/tmp" },
        },
      } as unknown as CursorSdkDelta,
    ];
    const agent = makeAgent(async (_message, options) => {
      for (const update of updates) await options?.onDelta?.({ update });
      return makeRun({
        id: "ordered-run",
        wait: async () => ({ id: "ordered-run", status: "finished", result: "done" }),
      });
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("ordered-events");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({ threadId, input: "go" });
        const events = [...(yield* Fiber.join(eventsFiber))];
        const lifecycle = events.filter(
          (event) =>
            event.type === "turn.started" ||
            event.type === "item.started" ||
            event.type === "content.delta" ||
            event.type === "item.completed" ||
            event.type === "turn.completed",
        );

        expect(lifecycle.map((event) => event.type)).toEqual([
          "turn.started",
          "item.started",
          "content.delta",
          "item.started",
          "content.delta",
          "item.started",
          "item.completed",
          "item.completed",
          "item.completed",
          "turn.completed",
        ]);
        const terminalTurnIndex = lifecycle.findIndex((event) => event.type === "turn.completed");
        for (const started of lifecycle.filter((event) => event.type === "item.started")) {
          const completedIndex = lifecycle.findIndex(
            (event) => event.type === "item.completed" && event.itemId === started.itemId,
          );
          expect(completedIndex).toBeGreaterThan(-1);
          expect(completedIndex).toBeLessThan(terminalTurnIndex);
        }
      }),
    );
  });

  it.effect("terminalizes started items before reporting an SDK run error", () => {
    const agent = makeAgent(async (_message, options) => {
      await options?.onDelta?.({
        update: { type: "text-delta", text: "partial" } as CursorSdkDelta,
      });
      return makeRun({
        id: "failed-run",
        wait: async () => ({
          id: "failed-run",
          status: "error",
          error: { message: "provider failed", code: "RUN_FAILED" },
        }),
      });
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("failed-events");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "fail" }));
        const events = [...(yield* Fiber.join(eventsFiber))];
        const itemStartedIndex = events.findIndex((event) => event.type === "item.started");
        const itemCompletedIndex = events.findIndex((event) => event.type === "item.completed");
        const turnCompletedIndex = events.findIndex((event) => event.type === "turn.completed");
        const terminal = events[turnCompletedIndex];

        expect(exit._tag).toBe("Failure");
        expect(itemStartedIndex).toBeGreaterThan(-1);
        expect(itemCompletedIndex).toBeGreaterThan(itemStartedIndex);
        expect(turnCompletedIndex).toBeGreaterThan(itemCompletedIndex);
        expect(terminal?.payload).toMatchObject({
          state: "failed",
          errorMessage: "provider failed",
          errorCode: "RUN_FAILED",
        });
      }),
    );
  });

  it.effect("forces a stuck cancelled run down before emitting an error session exit", () => {
    const waitResult = latch<CursorSdkRunResult>();
    const sendStarted = latch<void>();
    const events: Array<{ readonly type: string; readonly payload?: unknown }> = [];
    const run = makeRun({
      id: "stuck-run",
      wait: () => waitResult.promise,
    });
    const agent = makeAgent(async (_message, options) => {
      await options?.onDelta?.({
        update: { type: "text-delta", text: "partial" } as CursorSdkDelta,
      });
      sendStarted.resolve();
      return run;
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("forced-shutdown");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.runDrain,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({ threadId, input: "never settles" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => sendStarted.promise);
        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(stopFiber);

        const sessionExitIndex = events.findIndex((event) => event.type === "session.exited");
        const terminalTurnIndexes = events.flatMap((event, index) =>
          event.type === "turn.completed" ? [index] : [],
        );
        expect(terminalTurnIndexes).toHaveLength(1);
        expect(terminalTurnIndexes[0]).toBeLessThan(sessionExitIndex);
        expect(events[sessionExitIndex]?.payload).toMatchObject({ exitKind: "error" });

        waitResult.resolve({ id: "stuck-run", status: "finished", result: "late" });
        yield* Effect.yieldNow;
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        yield* Fiber.interrupt(eventsFiber);
        yield* Fiber.await(sendFiber);
      }),
    );
  });

  it.effect("redacts SDK failures and writes only structural native diagnostics", () => {
    const nativeRecords: unknown[] = [];
    const agent = makeAgent(async (_message, options) => {
      await options?.onDelta?.({
        update: { type: "text-delta", text: "sensitive response" } as CursorSdkDelta,
      });
      throw Object.assign(new Error("CURSOR_API_KEY=super-secret failed"), {
        context: { authorization: "Bearer super-secret" },
      });
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
          nativeEventLogger: {
            filePath: "/unused",
            write: (event) => Effect.sync(() => nativeRecords.push(event)),
            close: () => Effect.void,
          },
        });
        const threadId = ThreadId.make("redacted-sdk-error");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "fail" }));

        expect(encodeUnknownJson(error)).not.toContain("super-secret");
        expect(encodeUnknownJson(nativeRecords)).not.toContain("sensitive response");
        expect(nativeRecords).toEqual([
          expect.objectContaining({
            event: expect.objectContaining({
              kind: "run.delta",
              payload: { deltaType: "text-delta" },
            }),
          }),
        ]);
      }),
    );
  });

  it.effect("rehydrates user, agent, and shell conversation turns", () => {
    const conversation = [
      {
        type: "agentConversationTurn",
        turn: {
          userMessage: { text: "inspect the repository" },
          steps: [{ type: "assistantMessage", message: { text: "done" } }],
        },
      },
      {
        type: "shellConversationTurn",
        turn: {
          shellCommand: { command: "pwd" },
          shellOutput: { stdout: "/workspace\n", stderr: "", exitCode: 0 },
        },
      },
    ] as ReadonlyArray<CursorSdkConversationTurn>;
    const run = {
      ...makeRun({
        id: "history-run",
        wait: async () => ({ id: "history-run", status: "finished", result: "done" }),
      }),
      supports: (operation: string) => operation === "conversation",
      conversation: async () => [...conversation],
    } as CursorSdkRun;
    const agent = makeAgent(async () => run);
    const client = { ...makeClient(agent), getRun: async () => run };

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client,
        });
        const threadId = ThreadId.make("history");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "go" });
        const snapshot = yield* adapter.readThread(threadId);

        expect(snapshot.turns).toEqual([
          {
            id: "cursor-sdk-history-1",
            items: [
              { type: "userMessage", message: { text: "inspect the repository" } },
              { type: "assistantMessage", message: { text: "done" } },
            ],
          },
          {
            id: "cursor-sdk-history-2",
            items: [
              {
                type: "shellConversationTurn",
                shellCommand: { command: "pwd" },
                shellOutput: { stdout: "/workspace\n", stderr: "", exitCode: 0 },
              },
            ],
          },
        ]);
      }),
    );
  });

  it.effect("validates every attachment before emitting turn.started", () => {
    let sendCalls = 0;
    const observedEvents: unknown[] = [];
    const agent = makeAgent(async () => {
      sendCalls += 1;
      return makeRun({
        id: "unused",
        wait: async () => ({ id: "unused", status: "finished" }),
      });
    });

    return withAdapterServices(
      Effect.gen(function* () {
        const adapter = yield* makeCursorSdkAdapter({
          environment: { CURSOR_API_KEY: "test-key" },
          client: makeClient(agent),
        });
        const threadId = ThreadId.make("missing-attachment");
        yield* adapter.startSession({
          provider: cursorSdk,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.tap((event) => Effect.sync(() => observedEvents.push(event))),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const exit = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "with image",
            attachments: [
              {
                type: "image",
                id: "does-not-exist",
                name: "missing.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          }),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        expect(exit._tag).toBe("Failure");
        expect(sendCalls).toBe(0);
        expect(observedEvents).toEqual([]);
      }),
    );
  });
});

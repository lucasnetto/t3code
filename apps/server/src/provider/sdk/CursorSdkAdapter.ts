import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  type CursorSdkAgent,
  type CursorSdkClientShape,
  type CursorSdkConversationTurn,
  type CursorSdkRun,
  type CursorSdkRunResult,
} from "../Services/CursorSdkClient.ts";
import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  type CursorSdkActiveItem,
  type CursorSdkDrainMessage,
  makeCursorSdkEventRuntime,
} from "./CursorSdkEventRuntime.ts";
import { classifyCursorSdkError, safeCursorSdkCause } from "./CursorSdkErrors.ts";
import { resolveCursorSdkModelSelection } from "./CursorSdkModels.ts";
import { CURSOR_SDK_DRIVER_KIND, resolveCursorSdkApiKey } from "./CursorSdkProvider.ts";
import { acquireInterruptibleResource, releaseCursorSdkAgent } from "./CursorSdkResource.ts";
import { makeLazyCursorSdkStore } from "./CursorSdkStore.ts";

const PROVIDER = CURSOR_SDK_DRIVER_KIND;
const RESUME_VERSION = 1 as const;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const FORCED_SHUTDOWN_TIMEOUT_MS = 1_000;
const CANCEL_TIMEOUT_MS = 2_000;
const DELTA_QUEUE_CAPACITY = 256;

type SessionState = "creating" | "ready" | "running" | "stopping" | "stopped";
type CursorSdkAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;
type TurnCompletedPayload = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.completed" }
>["payload"];

interface CursorSdkResumeCursor {
  readonly schemaVersion: typeof RESUME_VERSION;
  readonly provider: "cursorSdk";
  readonly agentId: string;
  readonly runId?: string | undefined;
}

interface ActiveRunState {
  readonly turnId: TurnId;
  run: CursorSdkRun | undefined;
  cancelRequested: boolean;
  cancelFailed: boolean;
  readonly settled: Deferred.Deferred<void>;
  readonly forceShutdown: Deferred.Deferred<void>;
  forceTerminalize: () => Effect.Effect<void, never, never>;
}

interface CursorSdkSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly agent: CursorSdkAgent;
  readonly redactSecrets: ReadonlyArray<string>;
  readonly sendLock: Semaphore.Semaphore;
  session: ProviderSession;
  state: SessionState;
  activeRun: ActiveRunState | undefined;
  latestRunId: string | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly agentDisposalFailed: () => boolean;
  eventsOpen: boolean;
  disposed: boolean;
}

interface CursorSdkCreationContext {
  readonly threadId: ThreadId;
  readonly state: "creating";
  readonly session: ProviderSession;
  readonly cancelled: Deferred.Deferred<void>;
}

interface LifecycleLockEntry {
  readonly lock: Semaphore.Semaphore;
  users: number;
}

interface PreparedMessage {
  readonly text: string;
  readonly images: ReadonlyArray<{ data: string; mimeType: string }>;
}

export interface CursorSdkAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly client: CursorSdkClientShape;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResumeCursor(raw: unknown): CursorSdkResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.schemaVersion !== RESUME_VERSION ||
    raw.provider !== "cursorSdk" ||
    typeof raw.agentId !== "string" ||
    !raw.agentId.trim()
  ) {
    return undefined;
  }
  if (raw.runId !== undefined && (typeof raw.runId !== "string" || !raw.runId.trim())) {
    return undefined;
  }
  return {
    schemaVersion: RESUME_VERSION,
    provider: "cursorSdk",
    agentId: raw.agentId.trim(),
    ...(typeof raw.runId === "string" ? { runId: raw.runId.trim() } : {}),
  };
}

function makeResumeCursor(agentId: string, runId?: string): CursorSdkResumeCursor {
  return {
    schemaVersion: RESUME_VERSION,
    provider: "cursorSdk",
    agentId,
    ...(runId ? { runId } : {}),
  };
}

function validateRuntimeMode(
  mode: RuntimeMode,
): Effect.Effect<void, ProviderAdapterValidationError> {
  return mode === "full-access"
    ? Effect.void
    : Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Cursor SDK supports only 'full-access'; received '${mode}'.`,
        }),
      );
}

function historyFromConversation(
  threadId: ThreadId,
  conversation: ReadonlyArray<CursorSdkConversationTurn>,
): ProviderThreadSnapshot {
  const turns = conversation.map((entry, index) => ({
    id: TurnId.make(`cursor-sdk-history-${index + 1}`),
    items:
      entry.type === "agentConversationTurn"
        ? [
            ...(entry.turn.userMessage
              ? [{ type: "userMessage", message: entry.turn.userMessage }]
              : []),
            ...entry.turn.steps,
          ]
        : [{ type: "shellConversationTurn", ...entry.turn }],
  }));
  return { threadId, turns };
}

function runFailureDetail(error: unknown, secrets: ReadonlyArray<string> = []): string {
  const info = classifyCursorSdkError(error, secrets);
  return `${info.kind}: ${info.message}${info.code ? ` (${info.code})` : ""}`;
}

export const makeCursorSdkAdapter = Effect.fn("makeCursorSdkAdapter")(function* (
  options: CursorSdkAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("cursorSdk");
  const environment = options.environment ?? process.env;
  const client = options.client;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const adapterScope = yield* Effect.scope;
  const runtimeEvents = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const lifecycleLocks = new Map<ThreadId, LifecycleLockEntry>();
  const lifecycleRegistryLock = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, CursorSdkSessionContext>();
  const creations = new Map<ThreadId, CursorSdkCreationContext>();
  const creationCancellations = new Map<ThreadId, Set<Deferred.Deferred<void>>>();
  const lazyStore = yield* makeLazyCursorSdkStore<void, ProviderAdapterProcessError>({
    client,
    workspaceRef: serverConfig.cwd,
    stateRoot: path.join(serverConfig.stateDir, "cursor-sdk", boundInstanceId),
    registerOwnerFinalizer: false,
    mapOpenError: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: "store",
        detail: `Failed to open Cursor SDK durable store: ${runFailureDetail(cause)}`,
        cause: safeCursorSdkCause(cause),
      }),
    onDisposeError: (cause) =>
      Effect.logWarning("Failed to dispose Cursor SDK durable store.", {
        providerInstanceId: boundInstanceId,
        cause,
      }),
  });
  const getStore = lazyStore.get;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nextUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate a Cursor SDK runtime identifier.",
          cause,
        }),
    ),
  );
  const makeStamp = () =>
    Effect.all({
      eventId: crypto.randomUUIDv4.pipe(Effect.map(EventId.make), Effect.orDie),
      createdAt: nowIso,
    });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  const eventBase = (threadId: ThreadId, turnId?: TurnId) => ({
    provider: PROVIDER,
    providerInstanceId: boundInstanceId,
    threadId,
    ...(turnId ? { turnId } : {}),
  });

  const writeNativeDiagnostic = Effect.fn("CursorSdkAdapter.writeNativeDiagnostic")(function* (
    threadId: ThreadId,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ) {
    if (!options.nativeEventLogger) return;
    const observedAt = yield* nowIso;
    yield* options.nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          kind: kind.slice(0, 128),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          createdAt: observedAt,
          payload,
        },
      },
      threadId,
    );
  });

  const acquireLifecycleLockEntry = Effect.fn("CursorSdkAdapter.acquireLifecycleLockEntry")(
    function* (threadId: ThreadId) {
      return yield* lifecycleRegistryLock.withPermit(
        Effect.gen(function* () {
          const existing = lifecycleLocks.get(threadId);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 } satisfies LifecycleLockEntry;
          lifecycleLocks.set(threadId, entry);
          return entry;
        }),
      );
    },
  );
  const releaseLifecycleLockEntry = (threadId: ThreadId, entry: LifecycleLockEntry) =>
    lifecycleRegistryLock.withPermit(
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0 && lifecycleLocks.get(threadId) === entry) {
          lifecycleLocks.delete(threadId);
        }
      }),
    );
  const withLifecycleLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireLifecycleLockEntry(threadId),
      (entry) => entry.lock.withPermit(effect),
      (entry) => releaseLifecycleLockEntry(threadId, entry),
    );

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<CursorSdkSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && context.state !== "stopped"
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelActiveRun = Effect.fn("CursorSdkAdapter.cancelActiveRun")(function* (
    context: CursorSdkSessionContext,
  ) {
    const active = context.activeRun;
    if (!active) return true;
    active.cancelRequested = true;
    if (!active.run) return true;
    const result = yield* Effect.tryPromise(() => active.run!.cancel()).pipe(
      Effect.timeoutOption(CANCEL_TIMEOUT_MS),
      Effect.result,
    );
    const succeeded = result._tag === "Success" && Option.isSome(result.success);
    if (!succeeded) {
      active.cancelFailed = true;
      yield* writeNativeDiagnostic(context.threadId, "run.cancel.failed", {
        runId: active.run.id.slice(0, 128),
        ...(result._tag === "Failure"
          ? { cause: safeCursorSdkCause(result.failure) }
          : { reason: "timeout" }),
      });
    }
    return succeeded;
  });

  const disposeSession = Effect.fn("CursorSdkAdapter.disposeSession")(function* (
    context: CursorSdkSessionContext,
    emitExit: boolean,
  ) {
    if (context.disposed) return;
    context.state = "stopping";
    const activeAtShutdown = context.activeRun;
    const cancellationSucceeded = yield* cancelActiveRun(context);
    const settled = context.activeRun?.settled;
    let settledWithinBound = true;
    if (settled) {
      const result = yield* Deferred.await(settled).pipe(Effect.timeoutOption(SHUTDOWN_TIMEOUT_MS));
      settledWithinBound = Option.isSome(result);
      if (!settledWithinBound) {
        const active = context.activeRun;
        if (active) yield* Deferred.succeed(active.forceShutdown, undefined).pipe(Effect.ignore);
        const forcedSettlement = yield* Deferred.await(settled).pipe(
          Effect.timeoutOption(FORCED_SHUTDOWN_TIMEOUT_MS),
        );
        if (Option.isNone(forcedSettlement) && active) {
          yield* active.forceTerminalize();
        }
      }
    }
    context.eventsOpen = false;
    context.disposed = true;
    context.state = "stopped";
    sessions.delete(context.threadId);
    yield* Scope.close(context.scope, Exit.void);
    const graceful =
      cancellationSucceeded &&
      !activeAtShutdown?.cancelFailed &&
      settledWithinBound &&
      !context.agentDisposalFailed();
    if (emitExit) {
      yield* publish({
        type: "session.exited",
        ...(yield* makeStamp()),
        ...eventBase(context.threadId),
        payload: graceful
          ? { exitKind: "graceful" }
          : {
              exitKind: "error",
              reason: !settledWithinBound
                ? "Cursor SDK run did not settle before forced shutdown."
                : !cancellationSucceeded || activeAtShutdown?.cancelFailed
                  ? "Cursor SDK run cancellation failed."
                  : "Cursor SDK agent disposal failed.",
              recoverable: true,
            },
      });
    }
  });

  const prepareMessage = Effect.fn("CursorSdkAdapter.prepareMessage")(function* (
    input: ProviderSendTurnInput,
  ) {
    const text = input.input?.trim() ?? "";
    const images: Array<{ data: string; mimeType: string }> = [];
    for (const attachment of input.attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cursor-sdk/read-attachment",
              detail: `Failed to read attachment '${attachment.id}'.`,
              cause,
            }),
        ),
      );
      images.push({ data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType });
    }
    if (!text && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Turn requires non-empty text or at least one attachment.",
      });
    }
    return { text, images } satisfies PreparedMessage;
  });

  const { drainDeltas, terminalizeItems } = makeCursorSdkEventRuntime({
    providerInstanceId: boundInstanceId,
    publishEvent: publish,
    makeStamp,
    eventBase,
  });

  const startSession: ProviderAdapterShape<CursorSdkAdapterError>["startSession"] = Effect.fn(
    "CursorSdkAdapter.startSession",
  )(function* (input) {
    const cancelled = yield* Deferred.make<void>();
    const pending = creationCancellations.get(input.threadId) ?? new Set();
    pending.add(cancelled);
    creationCancellations.set(input.threadId, pending);
    return yield* withLifecycleLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider instance '${boundInstanceId}'.`,
          });
        }
        yield* validateRuntimeMode(input.runtimeMode);
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (
          input.resumeCursor !== undefined &&
          parseResumeCursor(input.resumeCursor) === undefined
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Malformed or incompatible Cursor SDK resume cursor.",
          });
        }
        const apiKey = resolveCursorSdkApiKey(environment);
        if (!apiKey) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "CURSOR_API_KEY is required in the provider instance environment.",
          });
        }
        const cwd = path.resolve(input.cwd.trim());
        const existing = sessions.get(input.threadId);
        if (existing) yield* disposeSession(existing, true);
        const resume = parseResumeCursor(input.resumeCursor);
        const modelSelection = resolveCursorSdkModelSelection(input.modelSelection);
        const now = yield* nowIso;
        const creation = {
          threadId: input.threadId,
          state: "creating",
          cancelled,
          session: {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "connecting",
            runtimeMode: "full-access",
            cwd,
            model: modelSelection.id,
            threadId: input.threadId,
            ...(resume ? { resumeCursor: resume } : {}),
            createdAt: now,
            updatedAt: now,
          },
        } satisfies CursorSdkCreationContext;
        creations.set(input.threadId, creation);

        const createSession = Effect.gen(function* () {
          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          return yield* Effect.gen(function* () {
            const store = yield* getStore(undefined);
            let agentDisposalFailed = false;
            const releaseAgent = (acquired: CursorSdkAgent) =>
              releaseCursorSdkAgent({
                agent: acquired,
                secrets: [apiKey],
                timeoutMs: CANCEL_TIMEOUT_MS,
                onFailure: (failure) => {
                  agentDisposalFailed = true;
                  return writeNativeDiagnostic(input.threadId, "agent.dispose.failed", failure);
                },
              });
            const agent = yield* acquireInterruptibleResource({
              acquire: () =>
                resume
                  ? client.resumeAgent(resume.agentId, {
                      apiKey,
                      model: modelSelection,
                      local: { cwd, store: store.value, autoReview: false },
                    })
                  : client.createAgent({
                      apiKey,
                      model: modelSelection,
                      local: { cwd, store: store.value, autoReview: false },
                      mode: "agent",
                    }),
              mapError: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: `Failed to ${resume ? "resume" : "create"} Cursor SDK agent: ${runFailureDetail(cause, [apiKey])}`,
                  cause: safeCursorSdkCause(cause, [apiKey]),
                }),
              release: releaseAgent,
            }).pipe(Effect.provideService(Scope.Scope, sessionScope));
            const sendLock = yield* Semaphore.make(1);
            const session: ProviderSession = {
              ...creation.session,
              status: "ready",
              resumeCursor: makeResumeCursor(agent.agentId, resume?.runId),
              updatedAt: yield* nowIso,
            };
            const context: CursorSdkSessionContext = {
              threadId: input.threadId,
              scope: sessionScope,
              agent,
              redactSecrets: [apiKey],
              sendLock,
              session,
              state: "ready",
              activeRun: undefined,
              latestRunId: resume?.runId,
              turns: [],
              agentDisposalFailed: () => agentDisposalFailed,
              eventsOpen: true,
              disposed: false,
            };
            sessions.set(input.threadId, context);
            scopeTransferred = true;
            yield* publish({
              type: "session.started",
              ...(yield* makeStamp()),
              ...eventBase(input.threadId),
              payload: { resume: session.resumeCursor },
            });
            yield* publish({
              type: "session.state.changed",
              ...(yield* makeStamp()),
              ...eventBase(input.threadId),
              payload: { state: "ready", reason: "Cursor SDK session ready" },
            });
            yield* publish({
              type: "thread.started",
              ...(yield* makeStamp()),
              ...eventBase(input.threadId),
              payload: { providerThreadId: agent.agentId },
            });
            return session;
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
              ),
            ),
          );
        });
        const cancellation = Deferred.await(cancelled).pipe(Effect.flatMap(() => Effect.interrupt));
        return yield* Effect.raceFirst(createSession, cancellation).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (creations.get(input.threadId) === creation) creations.delete(input.threadId);
            }),
          ),
        );
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const current = creationCancellations.get(input.threadId);
          current?.delete(cancelled);
          if (current?.size === 0) creationCancellations.delete(input.threadId);
        }),
      ),
    );
  });

  const sendTurn: ProviderAdapterShape<CursorSdkAdapterError>["sendTurn"] = Effect.fn(
    "CursorSdkAdapter.sendTurn",
  )(function* (input) {
    const context = yield* requireSession(input.threadId);
    let turnLifecycle:
      | {
          readonly turnId: TurnId;
          readonly activeItems: Map<string, CursorSdkActiveItem>;
          readonly activeRun: ActiveRunState;
          readonly finalizeTurn: (
            failed: boolean,
            payload: TurnCompletedPayload,
            forcePublish?: boolean,
          ) => Effect.Effect<void, never, never>;
          terminalized: boolean;
        }
      | undefined;
    return yield* context.sendLock.withPermit(
      Effect.gen(function* () {
        if (context.state !== "ready") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Session is ${context.state}; a new turn cannot start.`,
          });
        }
        const prepared = yield* prepareMessage(input);
        const turnId = TurnId.make(yield* nextUuid);
        const assistantItemId = `${turnId}:assistant`;
        const thinkingItemId = `${turnId}:thinking`;
        const activeItems = new Map<string, CursorSdkActiveItem>();
        const settled = yield* Deferred.make<void>();
        const forceShutdown = yield* Deferred.make<void>();
        const activeRun: ActiveRunState = {
          turnId,
          run: undefined,
          cancelRequested: false,
          cancelFailed: false,
          settled,
          forceShutdown,
          forceTerminalize: () => Effect.void,
        };
        const terminalLock = yield* Semaphore.make(1);
        const finalizeTurn: NonNullable<typeof turnLifecycle>["finalizeTurn"] = Effect.fn(
          "CursorSdkAdapter.finalizeTurn",
        )(function* (failed, payload, forcePublish = false) {
          yield* terminalLock.withPermit(
            Effect.suspend(() => {
              // Forced shutdown closes the event gate while holding the same
              // lock used to select the winning terminalizer. If a normal
              // finalizer already owns the lock, it completes its terminal
              // sequence first; otherwise no late delta can overtake the
              // forced terminal sequence.
              if (forcePublish) context.eventsOpen = false;
              if (turnLifecycle?.terminalized) return Effect.void;
              if (!forcePublish && !context.eventsOpen) return Effect.void;
              return Effect.gen(function* () {
                yield* terminalizeItems({
                  threadId: context.threadId,
                  turnId,
                  activeItems,
                  failed,
                  shouldPublish: () => forcePublish || context.eventsOpen,
                });
                if (forcePublish || context.eventsOpen) {
                  yield* publish({
                    type: "turn.completed",
                    ...(yield* makeStamp()),
                    ...eventBase(input.threadId, turnId),
                    payload,
                  });
                }
                if (turnLifecycle) turnLifecycle.terminalized = true;
              });
            }),
          );
        });
        turnLifecycle = { turnId, activeItems, activeRun, finalizeTurn, terminalized: false };
        activeRun.forceTerminalize = () =>
          finalizeTurn(
            true,
            {
              state: activeRun.cancelRequested && !activeRun.cancelFailed ? "cancelled" : "failed",
              stopReason: "shutdown-timeout",
            },
            true,
          );
        context.activeRun = activeRun;
        context.state = "running";
        const selectedModel =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection
            : context.session.model
              ? { instanceId: boundInstanceId, model: context.session.model }
              : undefined;
        const modelSelection = resolveCursorSdkModelSelection(selectedModel);
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model: modelSelection.id,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          type: "turn.started",
          ...(yield* makeStamp()),
          ...eventBase(input.threadId, turnId),
          payload: { model: modelSelection.id },
        });

        const queue = yield* Queue.bounded<CursorSdkDrainMessage>(DELTA_QUEUE_CAPACITY);
        const runtimeContext = yield* Effect.context<never>();
        const runPromise = Effect.runPromiseWith(runtimeContext);
        const drainFiber = yield* drainDeltas({
          threadId: context.threadId,
          turnId,
          queue,
          activeItems,
          assistantItemId,
          thinkingItemId,
          shouldPublish: () => context.eventsOpen,
        }).pipe(Effect.forkChild);
        let runResult: CursorSdkRunResult | undefined;
        let runError: unknown;
        let runErrorInfo: ReturnType<typeof classifyCursorSdkError> | undefined;
        let acceptingDeltas = true;
        const executeRun = Effect.tryPromise({
          try: async () => {
            const run = await context.agent.send(
              prepared.images.length > 0
                ? { text: prepared.text, images: [...prepared.images] }
                : prepared.text,
              {
                model: modelSelection,
                mode: input.interactionMode === "plan" ? "plan" : "agent",
                onDelta: ({ update }) => {
                  if (!acceptingDeltas) return Promise.resolve();
                  const deltaType =
                    isRecord(update) && typeof update.type === "string"
                      ? update.type.slice(0, 128)
                      : "unknown";
                  return runPromise(
                    writeNativeDiagnostic(input.threadId, "run.delta", { deltaType }).pipe(
                      Effect.andThen(Queue.offer(queue, { type: "delta", delta: update })),
                      Effect.asVoid,
                    ),
                  );
                },
              },
            );
            activeRun.run = run;
            context.latestRunId = run.id;
            if (activeRun.cancelRequested || context.state === "stopping") {
              try {
                await run.cancel();
              } catch (cause) {
                activeRun.cancelFailed = true;
                throw cause;
              }
            }
            runResult = await run.wait();
          },
          catch: (cause) => {
            runErrorInfo = classifyCursorSdkError(cause, context.redactSecrets);
            return new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cursor-sdk/send",
              detail: runFailureDetail(cause, context.redactSecrets),
              cause: safeCursorSdkCause(cause, context.redactSecrets),
            });
          },
        }).pipe(
          Effect.catch((cause) => {
            runError = cause;
            return Effect.void;
          }),
        );
        yield* Effect.raceFirst(
          executeRun,
          Deferred.await(forceShutdown).pipe(Effect.andThen(Effect.interrupt)),
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              acceptingDeltas = false;
              yield* Queue.offer(queue, { type: "end" });
              yield* Fiber.join(drainFiber).pipe(Effect.ignore);
            }),
          ),
        );

        const status = runResult?.status;
        const failed = runError !== undefined || status === "error";
        const cancelled =
          status === "cancelled" ||
          (status === undefined && activeRun.cancelRequested && !activeRun.cancelFailed);
        const terminalState = cancelled ? "cancelled" : failed ? "failed" : "completed";
        const resultErrorInfo = runResult?.error
          ? classifyCursorSdkError(runResult.error, context.redactSecrets)
          : undefined;
        const errorMessage = runErrorInfo?.message ?? resultErrorInfo?.message;
        const errorCode = runErrorInfo?.code ?? resultErrorInfo?.code;
        yield* finalizeTurn(failed, {
          state: terminalState,
          stopReason: status ?? null,
          ...(runResult?.usage ? { usage: runResult.usage } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorCode ? { errorCode } : {}),
          ...(runErrorInfo || resultErrorInfo
            ? { retryable: (runErrorInfo ?? resultErrorInfo)?.retryable }
            : {}),
        });

        const resumeCursor = makeResumeCursor(context.agent.agentId, context.latestRunId);
        context.turns.push({ id: turnId, items: [...activeItems.keys()] });
        context.activeRun = undefined;
        if (
          (context.state as SessionState) !== "stopping" &&
          (context.state as SessionState) !== "stopped"
        ) {
          context.state = "ready";
          context.session = {
            ...context.session,
            status: failed ? "error" : "ready",
            activeTurnId: undefined,
            resumeCursor,
            updatedAt: yield* nowIso,
            ...(errorMessage ? { lastError: errorMessage } : {}),
          };
        }
        yield* Deferred.succeed(settled, undefined).pipe(Effect.ignore);

        if (failed && !cancelled) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor-sdk/send",
            detail: errorMessage ?? "Cursor SDK run failed.",
            cause: runError,
          });
        }
        return { threadId: input.threadId, turnId, resumeCursor };
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const lifecycle = turnLifecycle;
            if (!lifecycle) return;
            if (!lifecycle.terminalized)
              yield* lifecycle.finalizeTurn(true, {
                state:
                  lifecycle.activeRun.cancelRequested && !lifecycle.activeRun.cancelFailed
                    ? "cancelled"
                    : "failed",
                stopReason: exit._tag === "Failure" ? "interrupted" : null,
              });
            if (context.activeRun?.turnId === lifecycle.turnId) context.activeRun = undefined;
            if (context.state === "running") {
              context.state = "ready";
              context.session = {
                ...context.session,
                status: exit._tag === "Failure" ? "error" : "ready",
                activeTurnId: undefined,
                updatedAt: yield* nowIso,
              };
            }
            yield* Deferred.succeed(lifecycle.activeRun.settled, undefined).pipe(Effect.ignore);
          }),
        ),
      ),
    );
  });

  const interruptTurn: ProviderAdapterShape<CursorSdkAdapterError>["interruptTurn"] = Effect.fn(
    "CursorSdkAdapter.interruptTurn",
  )(function* (threadId, turnId) {
    const context = yield* requireSession(threadId);
    const active = context.activeRun;
    if (!active || (turnId && turnId !== active.turnId)) return;
    const cancelled = yield* cancelActiveRun(context);
    if (!cancelled) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "cursor-sdk/cancel",
        detail: "Cursor SDK run cancellation failed.",
      });
    }
  });

  const stopSession: ProviderAdapterShape<CursorSdkAdapterError>["stopSession"] = Effect.fn(
    "CursorSdkAdapter.stopSession",
  )(function* (threadId) {
    for (const cancellation of creationCancellations.get(threadId) ?? []) {
      yield* Deferred.succeed(cancellation, undefined).pipe(Effect.ignore);
    }
    const creation = creations.get(threadId);
    if (creation) yield* Deferred.succeed(creation.cancelled, undefined).pipe(Effect.ignore);
    yield* withLifecycleLock(
      threadId,
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        yield* disposeSession(context, true);
      }),
    );
  });

  const readThread: ProviderAdapterShape<CursorSdkAdapterError>["readThread"] = Effect.fn(
    "CursorSdkAdapter.readThread",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    const store = yield* getStore(undefined);
    let run: CursorSdkRun | undefined;
    if (context.latestRunId) {
      run = yield* Effect.tryPromise(() =>
        client.getRun({
          runId: context.latestRunId!,
          cwd: context.session.cwd!,
          store: store.value,
        }),
      ).pipe(Effect.option, Effect.map(Option.getOrUndefined));
    }
    if (!run) {
      const runs = yield* Effect.tryPromise(() =>
        client.listRuns({
          agentId: context.agent.agentId,
          cwd: context.session.cwd!,
          store: store.value,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cursor-sdk/list-runs",
              detail: runFailureDetail(cause, context.redactSecrets),
              cause: safeCursorSdkCause(cause, context.redactSecrets),
            }),
        ),
      );
      run = runs.at(-1);
    }
    if (!run || !run.supports("conversation")) {
      return { threadId, turns: [...context.turns] };
    }
    const conversation = yield* Effect.tryPromise(() => run!.conversation()).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor-sdk/conversation",
            detail: runFailureDetail(cause, context.redactSecrets),
            cause: safeCursorSdkCause(cause, context.redactSecrets),
          }),
      ),
    );
    return historyFromConversation(threadId, conversation);
  });

  const unsupportedResponse = (operation: string) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: "Cursor SDK does not expose interactive approval responses in full-access mode.",
      }),
    );

  const adapter: ProviderAdapterShape<CursorSdkAdapterError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => unsupportedResponse("respondToRequest"),
    respondToUserInput: () => unsupportedResponse("respondToUserInput"),
    stopSession,
    listSessions: () =>
      Effect.succeed([
        ...[...creations.values()].map((context) => context.session),
        ...[...sessions.values()].map((context) => context.session),
      ]),
    hasSession: (threadId) =>
      Effect.succeed(
        sessions.has(threadId) || creations.has(threadId) || creationCancellations.has(threadId),
      ),
    readThread,
    rollbackThread: (_threadId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Cursor SDK durable conversation rollback is not supported.",
        }),
      ),
    stopAll: () =>
      Effect.forEach(
        [...new Set([...creationCancellations.keys(), ...creations.keys(), ...sessions.keys()])],
        stopSession,
        { discard: true, concurrency: "unbounded" },
      ),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  };

  yield* Scope.addFinalizer(
    adapterScope,
    Effect.uninterruptible(
      Effect.suspend(() => adapter.stopAll()).pipe(Effect.ensuring(lazyStore.close), Effect.ignore),
    ),
  );
  return adapter;
});

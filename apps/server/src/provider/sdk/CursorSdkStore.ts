import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { CursorSdkClientShape, CursorSdkStore } from "../Services/CursorSdkClient.ts";
import { safeCursorSdkCause } from "./CursorSdkErrors.ts";
import { acquireInterruptibleResource } from "./CursorSdkResource.ts";

export interface LazyCursorSdkStore<C, E> {
  readonly get: (context: C) => Effect.Effect<CursorSdkStore, E, never>;
  readonly close: Effect.Effect<void, never, never>;
}

export const makeLazyCursorSdkStore = Effect.fn("makeLazyCursorSdkStore")(function* <C, E>(input: {
  readonly client: CursorSdkClientShape;
  readonly workspaceRef: string;
  readonly stateRoot: string;
  readonly mapOpenError: (cause: unknown, context: C) => E;
  readonly onDisposeError?: ((cause: unknown) => Effect.Effect<void, never, never>) | undefined;
  readonly disposeTimeoutMs?: number | undefined;
  readonly registerOwnerFinalizer?: boolean | undefined;
}): Effect.fn.Return<LazyCursorSdkStore<C, E>, never, Scope.Scope> {
  const ownerScope = yield* Effect.scope;
  const storeScope = yield* Scope.make("sequential");
  // Register the child scope immediately, rather than when the store first
  // opens. Callers can therefore register higher-level shutdown finalizers
  // after constructing this lazy store and know those finalizers will run
  // before the store is disposed.
  const close = Scope.close(storeScope, Exit.void).pipe(Effect.ignore);
  if (input.registerOwnerFinalizer !== false) {
    yield* Scope.addFinalizer(ownerScope, close);
  }
  const lock = yield* Semaphore.make(1);
  let store: CursorSdkStore | undefined;
  const releaseStore = Effect.fn("CursorSdkStore.release")(function* (opened: CursorSdkStore) {
    const result = yield* Effect.tryPromise({
      try: () => opened.dispose(),
      catch: safeCursorSdkCause,
    }).pipe(Effect.timeoutOption(input.disposeTimeoutMs ?? 2_000), Effect.result);
    if (result._tag === "Success" && result.success._tag === "Some") return;
    const cause =
      result._tag === "Failure"
        ? result.failure
        : new Error("Cursor SDK store disposal timed out.");
    yield* input.onDisposeError?.(cause) ?? Effect.void;
  });

  const get = Effect.fn("CursorSdkStore.get")((context: C) =>
    lock.withPermit(
      Effect.suspend(() => {
        if (store) return Effect.succeed(store);
        return acquireInterruptibleResource({
          acquire: () =>
            input.client.openStore({
              workspaceRef: input.workspaceRef,
              stateRoot: input.stateRoot,
            }),
          mapError: (cause) => input.mapOpenError(cause, context),
          release: releaseStore,
        }).pipe(
          Effect.provideService(Scope.Scope, storeScope),
          Effect.tap((opened) =>
            Effect.sync(() => {
              store = opened;
            }),
          ),
        );
      }),
    ),
  );
  return { get, close };
});

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import type { CursorSdkAgent } from "../Services/CursorSdkClient.ts";
import { safeCursorSdkCause, type SafeCursorSdkCause } from "./CursorSdkErrors.ts";

export type CursorSdkReleaseFailure =
  | { readonly cause: SafeCursorSdkCause }
  | { readonly reason: "timeout" };

export const releaseCursorSdkAgent = Effect.fn("releaseCursorSdkAgent")(function* (input: {
  readonly agent: CursorSdkAgent;
  readonly secrets: ReadonlyArray<string>;
  readonly timeoutMs?: number | undefined;
  readonly onFailure: (failure: CursorSdkReleaseFailure) => Effect.Effect<void, never, never>;
}) {
  const result = yield* Effect.tryPromise({
    try: () => input.agent[Symbol.asyncDispose](),
    catch: (cause) => safeCursorSdkCause(cause, input.secrets),
  }).pipe(Effect.timeoutOption(input.timeoutMs ?? 2_000), Effect.result);
  if (result._tag === "Success" && Option.isSome(result.success)) return;
  yield* input.onFailure(
    result._tag === "Failure" ? { cause: result.failure } : { reason: "timeout" },
  );
});

/**
 * Acquires a Promise-backed resource without making the Promise an
 * uninterruptible region. If interruption wins before the Promise settles,
 * the eventual value is released in a detached, fully handled fiber. Once a
 * value wins, finalizer registration is atomic with respect to interruption.
 */
export const acquireInterruptibleResource = Effect.fn("acquireInterruptibleResource")(function* <
  A,
  E,
>(input: {
  readonly acquire: () => Promise<A>;
  readonly mapError: (cause: unknown) => E;
  readonly release: (resource: A) => Effect.Effect<void, never, never>;
}): Effect.fn.Return<A, E, Scope.Scope> {
  const scope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const acquire = Effect.callback<A, E>((resume, signal) => {
    let acquired: A | undefined;
    let interrupted = false;

    input.acquire().then(
      (resource) => {
        acquired = resource;
        if (interrupted || signal.aborted) {
          runFork(input.release(resource));
          return;
        }
        resume(Effect.succeed(resource));
      },
      (cause) => {
        if (!interrupted && !signal.aborted) resume(Effect.fail(input.mapError(cause)));
      },
    );

    return Effect.sync(() => {
      interrupted = true;
      if (acquired) runFork(input.release(acquired));
    });
  });

  return yield* Effect.uninterruptibleMask((restore) =>
    restore(acquire).pipe(
      Effect.tap((resource) => Scope.addFinalizer(scope, input.release(resource))),
    ),
  );
});

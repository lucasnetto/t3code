import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { CursorSdkClientShape, CursorSdkStore } from "../Services/CursorSdkClient.ts";
import { makeLazyCursorSdkStore } from "./CursorSdkStore.ts";

function latch<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CursorSdkStore", () => {
  it.effect("disposes a store acquired while its first caller is interrupted", () => {
    const openStarted = latch<void>();
    const releaseOpen = latch<CursorSdkStore>();
    const disposed = latch<void>();
    let disposeCalls = 0;
    const store: CursorSdkStore = {
      value: {} as CursorSdkStore["value"],
      dispose: async () => {
        disposeCalls += 1;
        disposed.resolve();
      },
    };
    const client = {
      openStore: async () => {
        openStarted.resolve();
        return releaseOpen.promise;
      },
    } as unknown as CursorSdkClientShape;

    return Effect.scoped(
      Effect.gen(function* () {
        const lazyStore = yield* makeLazyCursorSdkStore<void, Error>({
          client,
          workspaceRef: "/workspace",
          stateRoot: "/state",
          mapOpenError: (cause) => new Error("open failed", { cause }),
        });
        const getFiber = yield* lazyStore.get(undefined).pipe(Effect.forkChild);
        yield* Effect.promise(() => openStarted.promise);
        const interruptFiber = yield* Fiber.interrupt(getFiber).pipe(Effect.forkChild);
        yield* Fiber.join(interruptFiber);
        expect(disposeCalls).toBe(0);
        releaseOpen.resolve(store);
        yield* Effect.promise(() => disposed.promise);
      }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(disposeCalls).toBe(1);
        }),
      ),
    );
  });
});

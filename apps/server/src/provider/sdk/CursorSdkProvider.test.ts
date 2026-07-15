import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "@effect/vitest";

import type { CursorSdkSettings, ServerProviderModel } from "@t3tools/contracts";
import type { CursorSdkClientShape, CursorSdkModel } from "../Services/CursorSdkClient.ts";
import {
  buildInitialCursorSdkProviderSnapshot,
  checkCursorSdkProviderStatus,
} from "./CursorSdkProvider.ts";

const settings: CursorSdkSettings = { enabled: true, customModels: [] };
const unusedClient = {
  openStore: async () => Promise.reject(new Error("unused")),
  createAgent: async () => Promise.reject(new Error("unused")),
  resumeAgent: async () => Promise.reject(new Error("unused")),
  listRuns: async () => Promise.reject(new Error("unused")),
  getRun: async () => Promise.reject(new Error("unused")),
};

const model: CursorSdkModel = { id: "composer-2", displayName: "Composer 2" };

describe("CursorSdkProvider", () => {
  it.effect("advertises full-access only and explains a missing API key", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCursorSdkProviderSnapshot({ settings, environment: {} });

      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("CURSOR_API_KEY");
    }),
  );

  it.effect("reports account identity and discovered models after a successful probe", () => {
    const client: CursorSdkClientShape = {
      ...unusedClient,
      me: async () => ({
        apiKeyName: "Work Key",
        userEmail: "developer@example.com",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      listModels: async () => [model],
    };
    return Effect.gen(function* () {
      const lastKnownModels = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
      const snapshot = yield* checkCursorSdkProviderStatus({
        settings,
        environment: { CURSOR_API_KEY: "test-key" },
        client,
        lastKnownModels,
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toMatchObject({
        status: "authenticated",
        label: "Work Key",
        email: "developer@example.com",
      });
      expect(snapshot.models.map((entry) => entry.slug)).toContain("composer-2");
    });
  });

  it.effect("distinguishes authentication failures from transient failures", () => {
    const runProbe = (error: Error & { status?: number }) =>
      Effect.gen(function* () {
        const lastKnownModels = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([
          {
            slug: "cached",
            name: "Cached",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
        ]);
        return yield* checkCursorSdkProviderStatus({
          settings,
          environment: { CURSOR_API_KEY: "test-key" },
          client: {
            ...unusedClient,
            me: async () => Promise.reject(error),
            listModels: async () => [model],
          },
          lastKnownModels,
        });
      });

    return Effect.gen(function* () {
      const authError = Object.assign(new Error("unauthorized"), { status: 401 });
      const networkError = Object.assign(new Error("network unavailable"), {
        name: "NetworkError",
      });
      const auth = yield* runProbe(authError);
      expect(auth).toMatchObject({
        status: "warning",
        auth: { status: "unauthenticated" },
      });
      const network = yield* runProbe(networkError);
      expect(network).toMatchObject({ status: "error", auth: { status: "unknown" } });
      expect(network.models.map((entry) => entry.slug)).toContain("cached");
    });
  });
});

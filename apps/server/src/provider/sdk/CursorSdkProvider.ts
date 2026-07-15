import type {
  CursorSdkSettings,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { CursorSdkClientShape } from "../Services/CursorSdkClient.ts";
import { classifyCursorSdkError } from "./CursorSdkErrors.ts";
import { mapCursorSdkModels } from "./CursorSdkModels.ts";

export const CURSOR_SDK_DRIVER_KIND = ProviderDriverKind.make("cursorSdk");
export const CURSOR_SDK_VERSION = "1.0.23";
const PROBE_TIMEOUT_MS = 15_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export const CURSOR_SDK_PRESENTATION = {
  displayName: "Cursor SDK",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["auto-review", "full-access"] as const,
} as const;

export function resolveCursorSdkApiKey(
  environment: NodeJS.ProcessEnv | undefined,
): string | undefined {
  const value = environment?.CURSOR_API_KEY?.trim();
  return value || undefined;
}

function fallbackModels(
  settings: CursorSdkSettings,
  lastKnownModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    lastKnownModels,
    CURSOR_SDK_DRIVER_KIND,
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialCursorSdkProviderSnapshot(input: {
  readonly settings: CursorSdkSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const enabled = input.settings.enabled;
    const hasApiKey = resolveCursorSdkApiKey(input.environment) !== undefined;
    return buildServerProvider({
      presentation: CURSOR_SDK_PRESENTATION,
      enabled,
      checkedAt,
      models: fallbackModels(input.settings, []),
      skills: input.skills ?? [],
      probe: {
        installed: true,
        version: CURSOR_SDK_VERSION,
        status: "warning",
        auth: hasApiKey ? { status: "unknown" } : { status: "unauthenticated" },
        message: !enabled
          ? "Cursor SDK is disabled in T3 Code settings."
          : hasApiKey
            ? "Checking Cursor SDK account and models..."
            : "Add CURSOR_API_KEY to this provider instance's environment using a sensitive value.",
      },
    });
  });
}

export function checkCursorSdkProviderStatus(input: {
  readonly settings: CursorSdkSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly client: CursorSdkClientShape;
  readonly lastKnownModels: Ref.Ref<ReadonlyArray<ServerProviderModel>>;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const knownModels = yield* Ref.get(input.lastKnownModels);
    if (!input.settings.enabled) {
      return yield* buildInitialCursorSdkProviderSnapshot(input);
    }

    const apiKey = resolveCursorSdkApiKey(input.environment);
    if (!apiKey) {
      return buildServerProvider({
        presentation: CURSOR_SDK_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(input.settings, knownModels),
        skills: input.skills ?? [],
        probe: {
          installed: true,
          version: CURSOR_SDK_VERSION,
          status: "warning",
          auth: { status: "unauthenticated", type: "apiKey", label: "Cursor User API Key" },
          message:
            "Add CURSOR_API_KEY to this provider instance's environment using a sensitive value.",
        },
      });
    }

    const result = yield* Effect.tryPromise({
      try: () => Promise.all([input.client.me(apiKey), input.client.listModels(apiKey)]),
      catch: (cause) => classifyCursorSdkError(cause, [apiKey]),
    }).pipe(Effect.timeoutOption(PROBE_TIMEOUT_MS), Effect.result);

    if (result._tag === "Success" && Option.isSome(result.success)) {
      const [user, sdkModels] = result.success.value;
      const discoveredModels = mapCursorSdkModels(sdkModels);
      yield* Ref.set(input.lastKnownModels, discoveredModels);
      return buildServerProvider({
        presentation: CURSOR_SDK_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(input.settings, discoveredModels),
        skills: input.skills ?? [],
        probe: {
          installed: true,
          version: CURSOR_SDK_VERSION,
          status: "ready",
          auth: {
            status: "authenticated",
            type: "apiKey",
            label: user.apiKeyName?.trim() || "Cursor User API Key",
            ...(user.userEmail?.trim() ? { email: user.userEmail.trim() } : {}),
          },
        },
      });
    }

    const errorInfo =
      result._tag === "Success"
        ? { kind: "timeout" as const, message: "Cursor SDK account probe timed out." }
        : result.failure;
    const auth =
      errorInfo.kind === "authentication"
        ? ({ status: "unauthenticated", type: "apiKey", label: "Cursor User API Key" } as const)
        : ({ status: "unknown" } as const);
    const status = errorInfo.kind === "authentication" ? "warning" : "error";
    return buildServerProvider({
      presentation: CURSOR_SDK_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(input.settings, knownModels),
      skills: input.skills ?? [],
      probe: {
        installed: true,
        version: CURSOR_SDK_VERSION,
        status,
        auth,
        message: `Cursor SDK ${errorInfo.kind} check failed: ${errorInfo.message}`,
      },
    });
  });
}

export function withCursorSdkInstanceIdentity(input: {
  readonly instanceId: ServerProvider["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationGroupKey: string;
}): (snapshot: ServerProviderDraft) => ServerProvider {
  return (snapshot) => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: CURSOR_SDK_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
}

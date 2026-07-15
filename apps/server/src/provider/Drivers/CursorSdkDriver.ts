import { CursorSdkSettings, type ServerProvider, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCursorSdkTextGeneration } from "../../textGeneration/CursorSdkTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { discoverCursorSkills, resolveCursorSkillHomeDirectory } from "../cursorSkillDiscovery.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorSdkClient } from "../Services/CursorSdkClient.ts";
import { makeCursorSdkAdapter } from "../sdk/CursorSdkAdapter.ts";
import { safeCursorSdkCause } from "../sdk/CursorSdkErrors.ts";
import {
  buildInitialCursorSdkProviderSnapshot,
  checkCursorSdkProviderStatus,
  CURSOR_SDK_DRIVER_KIND,
  resolveCursorSdkApiKey,
  withCursorSdkInstanceIdentity,
} from "../sdk/CursorSdkProvider.ts";
import { makeLazyCursorSdkStore } from "../sdk/CursorSdkStore.ts";

const decodeSettings = Schema.decodeSync(CursorSdkSettings);
const REFRESH_INTERVAL = Duration.minutes(5);

export type CursorSdkDriverEnv =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | ProviderEventLoggers;

export const CursorSdkDriver: ProviderDriver<CursorSdkSettings, CursorSdkDriverEnv> = {
  driverKind: CURSOR_SDK_DRIVER_KIND,
  metadata: { displayName: "Cursor SDK", supportsMultipleInstances: true },
  configSchema: CursorSdkSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const client = yield* CursorSdkClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies CursorSdkSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: CURSOR_SDK_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withCursorSdkInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const skills = yield* discoverCursorSkills({
        cwd: serverConfig.cwd,
        homeDirectory: resolveCursorSkillHomeDirectory(processEnv),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const lastKnownModels = yield* Ref.make<ReadonlyArray<ServerProvider["models"][number]>>([]);

      const adapter = yield* makeCursorSdkAdapter({
        environment: processEnv,
        instanceId,
        client,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });

      const textGenerationStore = yield* makeLazyCursorSdkStore<
        TextGenerationError["operation"],
        TextGenerationError
      >({
        client,
        workspaceRef: serverConfig.cwd,
        stateRoot: path.join(serverConfig.stateDir, "cursor-sdk", instanceId, "text-generation"),
        mapOpenError: (cause, operation) =>
          new TextGenerationError({
            operation,
            detail: "Failed to open Cursor SDK text-generation store.",
            cause: safeCursorSdkCause(cause),
          }),
        onDisposeError: (cause) =>
          Effect.logWarning("Failed to dispose Cursor SDK text-generation store.", {
            providerInstanceId: instanceId,
            cause,
          }),
      });
      const textGeneration = yield* makeCursorSdkTextGeneration({
        apiKey: resolveCursorSdkApiKey(processEnv),
        client,
        getStore: textGenerationStore.get,
      });

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const initialSnapshot = (settings: ProviderSnapshotSettings<CursorSdkSettings>) =>
        buildInitialCursorSdkProviderSnapshot({
          settings: settings.provider,
          environment: processEnv,
          skills,
        }).pipe(Effect.map(stampIdentity));
      const checkProvider = checkCursorSdkProviderStatus({
        settings: effectiveConfig,
        environment: processEnv,
        client,
        lastKnownModels,
        skills,
      }).pipe(Effect.map(stampIdentity));
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<CursorSdkSettings>
      >({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: CURSOR_SDK_DRIVER_KIND,
          packageName: null,
        }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot,
        checkProvider,
        refreshInterval: REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: CURSOR_SDK_DRIVER_KIND,
              instanceId,
              detail: `Failed to build Cursor SDK snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: CURSOR_SDK_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

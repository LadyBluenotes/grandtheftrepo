/**
 * CopilotDriver — `ProviderDriver` for the GitHub Copilot CLI, composing the
 * ACP orchestration adapter, the snapshot/probe layer, and Copilot-backed text
 * generation. Copilot keeps its login, sessions, and settings under
 * `~/.copilot` (`COPILOT_HOME`), so the default instance grouping applies.
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { CopilotSettings } from "../settings.ts";
import { createCopilotAdapterV2, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import {
  copilotDiscoveryFromSession,
  discoverCopilotSession,
  type CopilotDiscovery,
} from "./discovery.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  COPILOT_SIGNED_OUT_MESSAGE,
  enrichCopilotSnapshot,
} from "./status.ts";
import { discoverCopilotSkills } from "./skills.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";
import { copilotUsageReader } from "./usage.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("copilot");
// npm's `latest` is the release channel `copilot update` installs from, so the
// registry stays the source for "latest".
const COPILOT_NPM_PACKAGE = "@github/copilot";
// `copilot update` finds the installer that owns the binary itself, so the
// resolved executable is its own updater. It honors `COPILOT_HOME`, so it runs
// with the instance's environment. No executable means nothing to update, not
// "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: COPILOT_NPM_PACKAGE,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "copilot",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: COPILOT_NPM_PACKAGE,
          }),
    ),
};

export type CopilotDriverEnv =
  | CopilotAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  usage: copilotUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv);

      // Copilot's catalog is only visible from a session. The first thread's
      // session seeds it; an explicit refresh replaces it.
      const discoveryRef = yield* Ref.make<CopilotDiscovery | undefined>(undefined);
      const { cwd } = host.paths;
      const checkProvider = Ref.get(discoveryRef).pipe(
        Effect.flatMap((discovery) =>
          checkCopilotProviderStatus(effectiveConfig, processEnv, cwd, discovery),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Ref.get(discoveryRef).pipe(
            Effect.flatMap((discovery) =>
              buildInitialCopilotProviderSnapshot(settings.provider, discovery),
            ),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichCopilotSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Copilot snapshot.",
              cause,
            }),
        ),
      );

      const scope = yield* Effect.scope;
      const orchestrationAdapter = yield* createCopilotAdapterV2(
        { instanceId, displayName, accentColor, environment, enabled, config },
        {
          onSessionSetup: (setup) => {
            const discovery = copilotDiscoveryFromSession(setup);
            if (discovery.models.length === 0) return Effect.void;
            return Ref.modify(discoveryRef, (previous) =>
              previous === undefined ? [true, discovery] : [false, previous],
            ).pipe(
              // The re-probe runs the CLI three times; it must not hold up the turn.
              Effect.flatMap((seeded) =>
                seeded ? snapshot.refresh.pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void,
              ),
            );
          },
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Copilot orchestration adapter.",
              cause,
            }),
        ),
      );

      // Explicit "refresh models": a disposable session reads Copilot's catalog.
      const refreshModels = () =>
        discoverCopilotSession(effectiveConfig, processEnv, cwd).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () => Effect.fail({ _tag: "Timeout" as const }),
          }),
          Effect.flatMap((discovery) => Ref.set(discoveryRef, discovery)),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "AcpRequestError" && cause.code === -32000
                    ? COPILOT_SIGNED_OUT_MESSAGE
                    : "Could not refresh Copilot models. The previous model list is unchanged.",
                cause,
              }),
          ),
        );

      // Seed the catalog once at startup so the picker lists models before any thread
      // runs. A failure (signed out, offline) leaves the default entry and manual refresh.
      if (effectiveConfig.enabled) {
        yield* refreshModels().pipe(
          Effect.flatMap(() => snapshot.refresh),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      }

      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverCopilotSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Copilot skills for '${workspaceCwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        refreshModels,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

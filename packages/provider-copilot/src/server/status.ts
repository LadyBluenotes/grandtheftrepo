/**
 * Snapshot and probe layer for the GitHub Copilot CLI. Health is `copilot
 * --version`; ACP support and sign-in are confirmed with `initialize` plus
 * `authenticate`, which never open a session, so the probe cannot start MCP
 * servers or run hooks. Copilot reports no models before a session exists, so
 * the picker offers the CLI's configured default until a session's discovery
 * supplies the real list, plus the user's custom model IDs.
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { selectAcpAgentAuthMethod } from "@t3tools/provider-acp/server/AcpSessionRuntime";

import type { CopilotSettings } from "../settings.ts";
import {
  COPILOT_DEFAULT_MODEL_SLUG,
  COPILOT_SUPPORTED_RUNTIME_MODES,
  makeCopilotAcpRuntime,
} from "./acpSupport.ts";
import type { CopilotDiscovery } from "./discovery.ts";
import { discoverCopilotSkills } from "./skills.ts";

const COPILOT_PRESENTATION = {
  displayName: "Copilot",
  supportsConversationRollback: false,
  // Plan mode rides on the ACP adapter's plan instructions and Copilot's own
  // plan session mode when it advertises one.
  showInteractionModeToggle: true,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` and `authenticate` are local round trips; the stored login is
// checked without a network call, so this is generous even on slow machines.
const COPILOT_ACP_PROBE_TIMEOUT_MS = 8_000;
/** The first Copilot CLI release whose `--acp` server shipped (public preview). */
const COPILOT_MINIMUM_ACP_VERSION = "0.0.397";
// ACP's auth-required code. Copilot answers `authenticate` and `session/new`
// with it while signed out; its only sign-in is `copilot login` in a terminal.
const ACP_AUTH_REQUIRED_CODE = -32000;
export const COPILOT_SIGNED_OUT_MESSAGE =
  "GitHub Copilot CLI is not signed in. Run `copilot login` on the machine running T3 Code.";

/**
 * Built-in commands Copilot runs when sent as prompt text over ACP. The CLI
 * advertises the live list only after a session opens, which the probe never
 * does. shortcut: the documented set as of CLI 1.0 minus `/model` and `/plan`,
 * which T3's own composer commands cover; replace with
 * `available_commands_update` once a session-backed catalog exists.
 */
const COPILOT_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  COMPACT_SLASH_COMMAND,
  { name: "context", description: "Show context window token usage" },
  { name: "usage", description: "Show session usage metrics per model" },
  { name: "env", description: "Show loaded instructions, MCP servers, skills, and agents" },
  { name: "mcp", description: "Show MCP servers", input: { hint: "list | show SERVER-NAME" } },
  {
    name: "review",
    description: "Run the code review agent on the current changes",
    input: { hint: "[PROMPT]" },
  },
  {
    name: "research",
    description: "Run a deep research investigation",
    input: { hint: "TOPIC" },
  },
  {
    name: "session",
    description: "Show session information",
    input: { hint: "info | checkpoints | files | plan" },
  },
];

const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COPILOT_DEFAULT_MODEL_SLUG,
    name: "Copilot default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
  discovery?: CopilotDiscovery,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels, discovery);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

/**
 * The default sentinel stays first and selected; discovered models follow it,
 * then custom IDs. The session's options ride on every entry so the composer
 * can drive them whichever model is picked.
 */
export function copilotModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovery?: CopilotDiscovery,
): ReadonlyArray<ServerProviderModel> {
  const capabilities = discovery?.capabilities ?? EMPTY_CAPABILITIES;
  return providerModelsFromSettings(
    [
      ...COPILOT_BUILT_IN_MODELS.map((model) => ({ ...model, capabilities })),
      ...(discovery?.models ?? []),
    ],
    customModels ?? [],
    capabilities,
  );
}

const runCopilotCliCommand = (
  copilotSettings: CopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Confirms the installed CLI speaks ACP and whether it is signed in. Copilot's
 * `authenticate` only checks its stored login or token variable: it succeeds
 * when one exists and fails with the auth-required code otherwise, so the
 * probe never opens a browser, a device-code flow, or a session.
 */
const probeCopilotAcp = (copilotSettings: CopilotSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    const authMethod = selectAcpAgentAuthMethod(initialized.authMethods);
    if (authMethod === undefined || acp.authenticate === undefined) {
      return { status: "unknown" } satisfies ServerProviderAuth;
    }
    return yield* acp.authenticate(authMethod.id).pipe(
      Effect.as({
        status: "authenticated",
        type: "cached_token",
        label: "GitHub account",
      } satisfies ServerProviderAuth),
      Effect.catchIf(
        (error: EffectAcpErrors.AcpError) =>
          error._tag === "AcpRequestError" && error.code === ACP_AUTH_REQUIRED_CODE,
        () => Effect.succeed({ status: "unauthenticated" } satisfies ServerProviderAuth),
      ),
    );
  }).pipe(Effect.scoped);

export function copilotAcpFailureMessage(version: string | null): string {
  return version !== null && compareSemverVersions(version, COPILOT_MINIMUM_ACP_VERSION) < 0
    ? `GitHub Copilot CLI ${version} predates ACP support. Update to ${COPILOT_MINIMUM_ACP_VERSION} or newer.`
    : "GitHub Copilot CLI is installed but its ACP server failed to initialize.";
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  discovery?: CopilotDiscovery,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = copilotModelsFromSettings(copilotSettings.customModels, discovery);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCopilotCliCommand(
    copilotSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute GitHub Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Copilot CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* discoverCopilotSkills(copilotSettings, environment, cwd).pipe(
    Effect.tapError((cause) => Effect.logDebug("Copilot skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );

  const acpExit = yield* probeCopilotAcp(copilotSettings, environment).pipe(
    Effect.timeoutOption(COPILOT_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(acpExit) || Option.isNone(acpExit.value)) {
    yield* Effect.logWarning("Copilot ACP probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: copilotAcpFailureMessage(version),
      },
    });
  }

  const auth = acpExit.value.value;
  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: COPILOT_SIGNED_OUT_MESSAGE,
      },
    });
  }

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills,
    slashCommands: COPILOT_SLASH_COMMANDS,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

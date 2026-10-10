/**
 * Snapshot and probe layer for the GitHub Copilot CLI. Health is `copilot
 * --version`; ACP support is confirmed with a bare `initialize`, which never
 * opens a session, so it cannot start MCP servers, run hooks, or prompt for
 * login. Copilot reports no models before a session exists, so the picker
 * offers the CLI's configured default plus the user's custom model IDs.
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

import type { CopilotSettings } from "../settings.ts";
import {
  COPILOT_DEFAULT_MODEL_SLUG,
  COPILOT_SUPPORTED_RUNTIME_MODES,
  hasCopilotTokenInEnvironment,
  makeCopilotAcpRuntime,
} from "./acpSupport.ts";
import { discoverCopilotSkills } from "./skills.ts";

const COPILOT_PRESENTATION = {
  displayName: "Copilot",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const COPILOT_ACP_INITIALIZE_TIMEOUT_MS = 8_000;
/** The first Copilot CLI release whose `--acp` server shipped (public preview). */
const COPILOT_MINIMUM_ACP_VERSION = "0.0.397";

/**
 * Built-in commands Copilot runs when sent as prompt text over ACP. The CLI
 * advertises the live list only after a session opens, which the probe never
 * does. shortcut: the documented set as of CLI 1.0; replace with
 * `available_commands_update` once a session-backed catalog exists.
 */
const COPILOT_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  COMPACT_SLASH_COMMAND,
  { name: "context", description: "Show context window token usage" },
  { name: "usage", description: "Show session usage metrics per model" },
  { name: "env", description: "Show loaded instructions, MCP servers, skills, and agents" },
  {
    name: "model",
    description: "Show or change the session's model",
    input: { hint: "[MODEL | auto]" },
  },
  { name: "mcp", description: "Show MCP servers", input: { hint: "list | show SERVER-NAME" } },
  {
    name: "plan",
    description: "Create an implementation plan before coding",
    input: { hint: "[PROMPT]" },
  },
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
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels);

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

function copilotModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    COPILOT_BUILT_IN_MODELS,
    customModels ?? [],
    EMPTY_CAPABILITIES,
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
 * Confirms the installed CLI speaks ACP. This stops after `initialize`: no
 * `authenticate`, no `session/new`, so the probe cannot open a browser login or
 * boot the workspace's MCP servers.
 */
const probeCopilotAcpInitialize = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.initialize();
  }).pipe(Effect.scoped);

/** How T3 reports Copilot's sign-in state without opening a session. */
export function copilotAuthFromEnvironment(environment: NodeJS.ProcessEnv): ServerProviderAuth {
  // A token variable replaces the stored login. Without one, only a session
  // can tell whether `copilot login` ran, so the state stays unknown here.
  return hasCopilotTokenInEnvironment(environment)
    ? { status: "authenticated", type: "api_key", label: "GitHub token" }
    : { status: "unknown" };
}

export function copilotAcpFailureMessage(version: string | null): string {
  return version !== null && compareSemverVersions(version, COPILOT_MINIMUM_ACP_VERSION) < 0
    ? `GitHub Copilot CLI ${version} predates ACP support. Update to ${COPILOT_MINIMUM_ACP_VERSION} or newer.`
    : "GitHub Copilot CLI is installed but its ACP server failed to initialize.";
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = copilotModelsFromSettings(copilotSettings.customModels);

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

  const auth = copilotAuthFromEnvironment(environment);

  const skills = yield* discoverCopilotSkills(copilotSettings, environment, cwd).pipe(
    Effect.tapError((cause) => Effect.logDebug("Copilot skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );

  const acpExit = yield* probeCopilotAcpInitialize(copilotSettings, environment).pipe(
    Effect.timeoutOption(COPILOT_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Copilot ACP initialize probe failed or timed out.", {
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
        auth,
        message: copilotAcpFailureMessage(version),
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

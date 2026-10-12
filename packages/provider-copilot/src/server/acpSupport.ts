/**
 * How T3 launches and talks to `copilot --acp`: the argv for each permission
 * mode, the environment it inherits, and model selection over ACP.
 *
 * @module provider-copilot/server/acpSupport
 */
import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { CopilotSettings } from "../settings.ts";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

/**
 * Copilot asks through `session/request_permission`; T3 answers by mode.
 * Copilot has no approval reviewer, so Auto approves every request, like Full
 * access but without Copilot's own allow-everything launch switch.
 */
export const COPILOT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

type CopilotAcpRuntimeCopilotSettings = Pick<CopilotSettings, "binaryPath">;

interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Launch argv for a runtime mode. `--acp` alone is stdio mode (the CLI infers
 * it; `--stdio` is accepted but undocumented in `copilot help`). Permission
 * flags are process-wide in Copilot's ACP server, so a mode change reopens the
 * session on a fresh process. Every mode but Full access launches asking.
 */
function copilotAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  return runtimeMode === "full-access" ? ["--acp", "--allow-all"] : ["--acp"];
}

/**
 * Explicit approval or sandbox overrides launch Copilot asking, so every
 * mutating prompt reaches T3's policy check instead of being waved through by
 * `--allow-all`.
 */
export function copilotLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: [...copilotAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { copilotSettings, environment, runtimeMode, ...runtimeInput } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeInput,
        spawn: buildCopilotAcpSpawnInput(copilotSettings, input.cwd, environment, runtimeMode),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in Copilot slug. It is not a model Copilot knows, so selecting it
 * means "whatever model the CLI is configured to use" (`COPILOT_MODEL` or its
 * settings file) and is never sent over the wire.
 */
export const COPILOT_DEFAULT_MODEL_SLUG = "default";

export function resolveCopilotAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : COPILOT_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, COPILOT_DRIVER_KIND) ?? COPILOT_DEFAULT_MODEL_SLUG;
}

/**
 * Apply a model selection to a freshly started session. T3's default slug and
 * Copilot's own `auto` keep the session's current model. A named model goes
 * through whichever switch the session advertised: the v2 model config option
 * or the v1 `session/set_model` model state (Copilot 1.0 negotiates ACP v1).
 * A session that advertises neither keeps its model rather than failing the turn.
 */
export function applyCopilotAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setSessionModel"
  >;
  readonly startResult: Pick<AcpSessionRuntime.AcpSessionRuntimeStartResult, "sessionSetupResult">;
  readonly requestedModelId: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const setup = input.startResult.sessionSetupResult;
  const current = currentCopilotModelIdFromSessionSetup(setup);
  const requested = input.requestedModelId;
  if (requested === COPILOT_DEFAULT_MODEL_SLUG || requested === "auto" || requested === current) {
    return Effect.succeed(current);
  }
  const hasModelConfig =
    setup.configOptions?.some((option) => option.category === "model") === true;
  if (hasModelConfig) {
    return input.runtime
      .setModel(requested)
      .pipe(Effect.mapError(input.mapError), Effect.as(requested));
  }
  if (setup.models !== undefined && setup.models !== null) {
    return input.runtime
      .setSessionModel(requested)
      .pipe(Effect.mapError(input.mapError), Effect.as(requested));
  }
  return Effect.succeed(current);
}

export function currentCopilotModelIdFromSessionSetup(
  sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): string | undefined {
  const modelOption = sessionSetupResult.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const configured =
    modelOption !== undefined && typeof modelOption.currentValue === "string"
      ? modelOption.currentValue.trim()
      : "";
  return configured || sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

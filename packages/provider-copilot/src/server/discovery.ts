/**
 * Model and option discovery from a Copilot ACP session. Copilot advertises
 * its models and tuning options (reasoning effort, context tier, modes) only
 * once a session exists, so this reads them from a live session's
 * configuration, or from a short disposable session on an explicit refresh.
 *
 * @module provider-copilot/server/discovery
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";

import type { CopilotSettings } from "../settings.ts";
import { currentCopilotModelIdFromSessionSetup, makeCopilotAcpRuntime } from "./acpSupport.ts";

export interface CopilotDiscovery {
  /** Models the session offered, the session's current one marked default. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** The session's tuning options, carried by every model so the composer can drive them. */
  readonly capabilities: ModelCapabilities;
}

// Copilot's `allow_all` option is its permission switch; T3's permission modes own that.
const HIDDEN_OPTION_IDS = new Set(["allow_all"]);

type SessionSetup = Pick<
  AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

export function copilotDiscoveryFromSession(input: {
  readonly setup: SessionSetup;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly modeState: AcpSessionModeState | undefined;
}): CopilotDiscovery {
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors(input).filter(
      (descriptor) => !HIDDEN_OPTION_IDS.has(descriptor.id),
    ),
  });
  const modelOption = input.configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  // The v2 model config option, or the v1 model state (Copilot 1.0 negotiates v1).
  const offered =
    modelOption?.type === "select"
      ? modelOption.options
          .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
          .map((choice) => ({ id: choice.value, name: choice.name }))
      : (input.setup.models?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
        }));
  const current = currentCopilotModelIdFromSessionSetup({
    configOptions: input.configOptions,
    ...(input.setup.models ? { models: input.setup.models } : {}),
  });
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of offered) {
    const slug = entry.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.name.trim() || slug,
      isCustom: false,
      ...(slug === current ? { isDefault: true } : {}),
      capabilities,
    });
  }
  return { models, capabilities };
}

/**
 * Opens a disposable session to read Copilot's catalog, then closes it. This
 * starts the workspace's MCP servers like any session, so it only runs on an
 * explicit model refresh, never from a background health check.
 */
export const discoverCopilotSession = Effect.fn("discoverCopilotSession")(function* (
  copilotSettings: Pick<CopilotSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const runtime = yield* makeCopilotAcpRuntime({
    copilotSettings,
    environment,
    cwd,
    clientInfo: { name: "t3-code-provider-refresh", version: "0.0.0" },
    mcpServers: [],
  });
  const started = yield* runtime.start();
  const discovery = copilotDiscoveryFromSession({
    setup: started.sessionSetupResult,
    configOptions: yield* runtime.getConfigOptions,
    modeState: yield* runtime.getModeState,
  });
  // Copilot advertises session/close; an agent without it just exits with the process.
  yield* runtime.closeSession().pipe(Effect.ignore);
  return discovery;
}, Effect.scoped);

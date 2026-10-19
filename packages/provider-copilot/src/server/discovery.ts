/**
 * Model and option discovery from a Copilot ACP session. Copilot advertises
 * its models and tuning options (reasoning effort, context tier, modes) only
 * once a session exists, so this reads them from a session's setup response:
 * a thread's own session, or a short disposable one on an explicit refresh.
 *
 * @module provider-copilot/server/discovery
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { parseSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";

import type { CopilotSettings } from "../settings.ts";
import { makeCopilotAcpRuntime } from "./acpSupport.ts";

export interface CopilotDiscovery {
  /** Models the session offered, in Copilot's order. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** The session's tuning options, carried by every model so the composer can drive them. */
  readonly capabilities: ModelCapabilities;
}

// Copilot's `allow_all` option is its permission switch; T3's permission modes own that.
const HIDDEN_OPTION_IDS = new Set(["allow_all"]);

export function copilotDiscoveryFromSession(
  setup: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): CopilotDiscovery {
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: setup.configOptions,
      modeState: parseSessionModeState(setup),
    }).filter((descriptor) => !HIDDEN_OPTION_IDS.has(descriptor.id)),
  });
  const modelOption = setup.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  // The v2 model config option, or the v1 model state (Copilot 1.0 negotiates v1).
  const offered =
    modelOption?.type === "select"
      ? modelOption.options
          .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
          .map((choice) => ({ id: choice.value, name: choice.name }))
      : (setup.models?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
        }));
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
  copilotSettings: Pick<CopilotSettings, "binaryPath" | "sessionBinaryPath">,
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
  // Copilot advertises session/close; an agent without it just exits with the process.
  yield* runtime.closeSession().pipe(Effect.ignore);
  return copilotDiscoveryFromSession(started.sessionSetupResult);
}, Effect.scoped);

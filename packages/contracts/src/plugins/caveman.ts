import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "../providerInstance.ts";
import { definePluginMethods } from "./method.ts";

/**
 * Where a provider sends model requests. `routed`: through caveman's proxy. `direct`: to the
 * vendor. `other`: a base URL that is neither. `unsupported`: this plugin cannot route it.
 */
export const CavemanRoute = Schema.Literals(["routed", "direct", "other", "unsupported"]);
export type CavemanRoute = typeof CavemanRoute.Type;

export const CavemanAgent = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);
export type CavemanAgent = typeof CavemanAgent.Type;

/** One configured provider instance: its route, and the config file the answer came from. */
export const CavemanAgentRoute = Schema.Struct({
  instanceId: ProviderInstanceId,
  agent: CavemanAgent,
  route: CavemanRoute,
  detail: Schema.NullOr(Schema.String),
  configPath: Schema.NullOr(Schema.String),
});
export type CavemanAgentRoute = typeof CavemanAgentRoute.Type;

export const CavemanStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  /** `listening` is null when the origin is not on this machine, so one connect says nothing. */
  proxy: Schema.Struct({ origin: Schema.String, listening: Schema.NullOr(Schema.Boolean) }),
  agents: Schema.Array(CavemanAgentRoute),
});
export type CavemanStatus = typeof CavemanStatus.Type;

export const CavemanSetRouteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
});
export type CavemanSetRouteInput = typeof CavemanSetRouteInput.Type;

/** What the panel shows when caveman is missing; the server's refusal carries the same command. */
export const CAVEMAN_INSTALL_COMMAND = "npm install -g @caveman-ai/cli && caveman setup --install";

export class CavemanError extends Schema.TaggedError<CavemanError>()("CavemanError", {
  code: Schema.Literals(["inactive", "not_installed", "not_routed", "failed"]),
  message: Schema.String,
}) {}

export const CAVEMAN_METHODS = definePluginMethods({
  status: {
    method: "caveman.status",
    gateway: "read",
    input: Schema.Struct({}),
    output: CavemanStatus,
    error: CavemanError,
  },
  setRoute: {
    method: "caveman.setRoute",
    gateway: "settingsWrite",
    input: CavemanSetRouteInput,
    output: CavemanStatus,
    error: CavemanError,
  },
});

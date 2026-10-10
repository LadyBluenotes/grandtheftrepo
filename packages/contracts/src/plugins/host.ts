import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

export const PLUGIN_WS_METHODS = {
  pluginsList: "plugins.list",
  pluginsSetEnabled: "plugins.setEnabled",
} as const;

/** One registered plugin. `enabled` is the saved choice; `active` is what this process runs. */
export const PluginStatus = Schema.Struct({
  id: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  /** Dependencies that would not run, so this plugin cannot either. */
  missing: Schema.Array(Schema.String),
});
export type PluginStatus = typeof PluginStatus.Type;

export class PluginHostError extends Schema.TaggedError<PluginHostError>()("PluginHostError", {
  message: Schema.String,
}) {}

const PluginsListRpc = Rpc.make(PLUGIN_WS_METHODS.pluginsList, {
  payload: Schema.Struct({}),
  success: Schema.Array(PluginStatus),
  error: EnvironmentAuthorizationError,
});

const PluginsSetEnabledRpc = Rpc.make(PLUGIN_WS_METHODS.pluginsSetEnabled, {
  payload: Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
  success: Schema.Array(PluginStatus),
  error: Schema.Union([EnvironmentAuthorizationError, PluginHostError]),
});

/** Spread into `WsRpcGroup`: the one place the core contract learns about plugins. */
export const PLUGIN_RPCS = [PluginsListRpc, PluginsSetEnabledRpc] as const;

export const PLUGIN_GUARDED_RPC_SCOPES = {
  [PLUGIN_WS_METHODS.pluginsList]: AuthOrchestrationReadScope,
  [PLUGIN_WS_METHODS.pluginsSetEnabled]: AuthSettingsWriteScope,
} as const;

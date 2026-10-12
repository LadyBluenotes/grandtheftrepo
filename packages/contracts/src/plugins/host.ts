import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  KANBAN_GUARDED_RPC_SCOPES,
  KANBAN_RPC_SCOPES,
  KANBAN_RPC_SUBSYSTEMS,
  KANBAN_RPCS,
  type KANBAN_WS_METHODS,
} from "./kanban.ts";
import { LEARNING_RPC_SCOPES, LEARNING_RPC_SUBSYSTEMS, LEARNING_RPCS } from "./learning.ts";

export * from "./kanban.ts";
export * from "./learning.ts";

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
  /** Why the plugin did not start this boot: a failed migration, or a dependency that failed. */
  startError: Schema.NullOr(Schema.String),
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
export const PLUGIN_RPCS = [
  PluginsListRpc,
  PluginsSetEnabledRpc,
  ...KANBAN_RPCS,
  ...LEARNING_RPCS,
] as const;

/** Writes the client must hold a grant for; spread into `CLIENT_GUARDED_RPC_SCOPES`. */
export const PLUGIN_GUARDED_RPC_SCOPES = {
  [PLUGIN_WS_METHODS.pluginsSetEnabled]: AuthSettingsWriteScope,
  ...KANBAN_GUARDED_RPC_SCOPES,
} as const;

/** Reads and subscriptions the server alone authorizes; spread into `RPC_REQUIRED_SCOPES`. */
export const PLUGIN_RPC_SCOPES = {
  [PLUGIN_WS_METHODS.pluginsList]: AuthOrchestrationReadScope,
  ...KANBAN_RPC_SCOPES,
  ...LEARNING_RPC_SCOPES,
} as const;

/** Stream RPCs plugins add; the client's subscription tag union includes it. */
export type PluginSubscriptionRpcTag = typeof KANBAN_WS_METHODS.subscribe;

/** Instrumentation subsystem per plugin method; spread into the server's subsystem map. */
export const PLUGIN_RPC_SUBSYSTEMS = {
  [PLUGIN_WS_METHODS.pluginsList]: "plugins",
  [PLUGIN_WS_METHODS.pluginsSetEnabled]: "plugins",
  ...KANBAN_RPC_SUBSYSTEMS,
  ...LEARNING_RPC_SUBSYSTEMS,
} as const;

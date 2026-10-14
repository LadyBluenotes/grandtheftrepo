import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { ProjectId } from "../baseSchemas.ts";
import {
  KANBAN_RPC_SCOPES,
  KANBAN_RPC_SUBSYSTEMS,
  KANBAN_RPCS,
  type KANBAN_WS_METHODS,
} from "./kanban.ts";
import { definePluginMethods } from "./method.ts";

export * from "./caveman.ts";
export * from "./kanban.ts";
export * from "./knowledge.ts";
export * from "./learning.ts";
export * from "./method.ts";
export * from "./policy.ts";
export * from "./prompts.ts";
export * from "./review.ts";
export * from "./routing.ts";
export * from "./supervisor.ts";
export * from "./telemetry.ts";
export * from "./telemetryReport.ts";

/**
 * One RPC per scope; plugin methods are dispatched behind them by name. The WebSocket group sits at
 * TypeScript's instantiation limit, so a plugin method never gets a tag of its own.
 */
export const PLUGIN_GATEWAY_WS_METHODS = {
  read: "plugins.read",
  operate: "plugins.operate",
  settingsWrite: "plugins.settingsWrite",
} as const;

/** A plugin method by name, with its input encoded by the method's `input` schema. */
export const PluginMethodCall = Schema.Struct({ method: Schema.String, input: Schema.Unknown });
export type PluginMethodCall = typeof PluginMethodCall.Type;

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

/** A plugin method's own failure, encoded with that method's `error` schema so the client can decode it. */
export class PluginMethodError extends Schema.TaggedError<PluginMethodError>()(
  "PluginMethodError",
  {
    method: Schema.String,
    error: Schema.Unknown,
  },
) {}

/**
 * How one readiness check stands: `ready` needs nothing, `attention` has something a person can
 * fix, and `off` is a plugin that does not run.
 */
export const ReadinessStatus = Schema.Literals(["ready", "attention", "off"]);
export type ReadinessStatus = typeof ReadinessStatus.Type;

/**
 * Where a person fixes a check: the plugin's row on the Plugins page (`plugins`), the plugin's own
 * screen (`plugin`), the project's board, the Usage page, or scheduled tasks.
 */
export const ReadinessTarget = Schema.Literals([
  "plugins",
  "plugin",
  "board",
  "usage",
  "scheduled_tasks",
]);
export type ReadinessTarget = typeof ReadinessTarget.Type;

/** One condition a plugin needs to do its work, with one sentence on how it stands. */
export const ReadinessCheck = Schema.Struct({
  /** Stable within its plugin. */
  id: Schema.String,
  label: Schema.String,
  status: ReadinessStatus,
  sentence: Schema.String,
  target: Schema.NullOr(ReadinessTarget),
});
export type ReadinessCheck = typeof ReadinessCheck.Type;

/** A plugin's checks, in registry order. A plugin that does not run has one `off` check saying why. */
export const PluginReadiness = Schema.Struct({
  plugin: Schema.String,
  checks: Schema.Array(ReadinessCheck),
});
export type PluginReadiness = typeof PluginReadiness.Type;

/** Without a project, the checks that need one are left out. */
export const PluginsReadinessInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type PluginsReadinessInput = typeof PluginsReadinessInput.Type;

export const HOST_METHODS = definePluginMethods({
  list: {
    method: "plugins.list",
    gateway: "read",
    input: Schema.Struct({}),
    output: Schema.Array(PluginStatus),
  },
  setEnabled: {
    method: "plugins.setEnabled",
    gateway: "settingsWrite",
    input: Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
    output: Schema.Array(PluginStatus),
    error: PluginHostError,
  },
  readiness: {
    method: "plugins.readiness",
    gateway: "read",
    input: PluginsReadinessInput,
    output: Schema.Array(PluginReadiness),
  },
});

const gateway = {
  payload: PluginMethodCall,
  success: Schema.Unknown,
  error: Schema.Union([EnvironmentAuthorizationError, PluginHostError, PluginMethodError]),
} as const;

/** Spread into `WsRpcGroup`: the one place the core contract learns about plugins. */
export const PLUGIN_RPCS = [
  Rpc.make(PLUGIN_GATEWAY_WS_METHODS.read, gateway),
  Rpc.make(PLUGIN_GATEWAY_WS_METHODS.operate, gateway),
  Rpc.make(PLUGIN_GATEWAY_WS_METHODS.settingsWrite, gateway),
  ...KANBAN_RPCS,
] as const;

/** Writes the client must hold a grant for; spread into `CLIENT_GUARDED_RPC_SCOPES`. */
export const PLUGIN_GUARDED_RPC_SCOPES = {
  [PLUGIN_GATEWAY_WS_METHODS.operate]: AuthOrchestrationOperateScope,
  [PLUGIN_GATEWAY_WS_METHODS.settingsWrite]: AuthSettingsWriteScope,
} as const;

/** Reads and subscriptions the server alone authorizes; spread into `RPC_REQUIRED_SCOPES`. */
export const PLUGIN_RPC_SCOPES = {
  [PLUGIN_GATEWAY_WS_METHODS.read]: AuthOrchestrationReadScope,
  ...KANBAN_RPC_SCOPES,
} as const;

/** Stream RPCs plugins add; the client's subscription tag union includes it. */
export type PluginSubscriptionRpcTag = typeof KANBAN_WS_METHODS.subscribe;

/** Instrumentation subsystem per plugin RPC; spread into the server's subsystem map. */
export const PLUGIN_RPC_SUBSYSTEMS = {
  [PLUGIN_GATEWAY_WS_METHODS.read]: "plugins",
  [PLUGIN_GATEWAY_WS_METHODS.operate]: "plugins",
  [PLUGIN_GATEWAY_WS_METHODS.settingsWrite]: "plugins",
  ...KANBAN_RPC_SUBSYSTEMS,
} as const;

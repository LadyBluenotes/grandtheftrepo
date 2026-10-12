import {
  HOST_METHODS,
  PLUGIN_GATEWAY_WS_METHODS,
  PluginHostError,
  SUPERVISOR_METHODS,
  type PluginMethodCall,
  type PluginStatus,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as PluginDatabase from "./PluginDatabase.ts";
import * as PluginRpc from "./PluginRpc.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import type { ServerPlugin } from "./Plugin.ts";
import { type PluginRequirements, registry } from "./registry.ts";
import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as KanbanHandlers from "./kanban/handlers.ts";
import * as SupervisorToolkit from "./supervisorToolkit.ts";
import * as TelemetryHandlers from "./telemetry/handlers.ts";

/** `plugins.json` under the state directory: plugin id to saved choice. Absent means enabled. */
const EnabledState = Schema.Record(Schema.String, Schema.Boolean);
type EnabledState = typeof EnabledState.Type;
const decodeEnabledState = Schema.decodeUnknownEffect(Schema.fromJsonString(EnabledState));
const encodeEnabledState = Schema.encodeUnknownEffect(fromJsonStringPretty(EnabledState));

type Registered = Pick<ServerPlugin, "id" | "dependsOn" | "migrations">;

/** A plugin runs when it is enabled and every dependency runs. An unknown dependency id never runs. */
export const resolve = (
  plugins: ReadonlyArray<Registered>,
  enabled: EnabledState,
): ReadonlyArray<PluginStatus> => {
  const active = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const plugin of plugins) {
      if (active.has(plugin.id)) continue;
      if ((enabled[plugin.id] ?? true) && plugin.dependsOn.every((id) => active.has(id))) {
        active.add(plugin.id);
        changed = true;
      }
    }
  }
  return plugins.map((plugin) => ({
    id: plugin.id,
    dependsOn: plugin.dependsOn,
    enabled: enabled[plugin.id] ?? true,
    active: active.has(plugin.id),
    missing: plugin.dependsOn.filter((id) => !active.has(id)),
    startError: null,
  }));
};

export class PluginHost extends Context.Service<
  PluginHost,
  {
    /** Plugins this process runs, decided once at boot. */
    readonly activeIds: ReadonlySet<string>;
    /** Each running plugin's own database, opened and migrated at boot. */
    readonly databases: ReadonlyMap<string, SqlClient.SqlClient>;
    /** Saved choice and running state for every registered plugin. */
    readonly statuses: Effect.Effect<ReadonlyArray<PluginStatus>>;
    /** Saves the choice. It applies on the next start; `activeIds` does not change. */
    readonly setEnabled: (
      id: string,
      enabled: boolean,
    ) => Effect.Effect<ReadonlyArray<PluginStatus>, PluginHostError>;
  }
>()("t3/plugins/PluginHost") {}

export const make = (plugins: ReadonlyArray<Registered>) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(stateDir, "plugins.json");

    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(filePath))) return {} as EnabledState;
      return yield* decodeEnabledState(yield* fs.readFileString(filePath));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("plugins.json unreadable, treating every plugin as enabled", {
          filePath,
          cause,
        }).pipe(Effect.as({} as EnabledState)),
      ),
    );

    const write = (state: EnabledState) =>
      Effect.gen(function* () {
        const contents = yield* encodeEnabledState(state);
        yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PluginHostError({ message: `Could not write ${filePath}: ${cause.message}` }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const pluginsDir = path.join(stateDir, "plugins");
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const wanted = resolve(plugins, yield* read)
      .filter((status) => status.active)
      .map((status) => status.id);
    const databases = new Map<string, SqlClient.SqlClient>();
    const startErrors = new Map<string, string>();
    // Dependency order: a plugin opens once every dependency has, and never after one failed.
    for (let progress = true; progress;) {
      progress = false;
      for (const id of wanted) {
        if (databases.has(id) || startErrors.has(id)) continue;
        const plugin = byId.get(id);
        if (plugin === undefined) continue;
        const failedDependency = plugin.dependsOn.find((dependency) => startErrors.has(dependency));
        if (failedDependency !== undefined) {
          startErrors.set(id, `Dependency "${failedDependency}" failed to start.`);
          progress = true;
          continue;
        }
        if (!plugin.dependsOn.every((dependency) => databases.has(dependency))) continue;
        progress = true;
        const opened = yield* Effect.gen(function* () {
          if (plugin.migrations === undefined) {
            return yield* PluginDatabase.open({ id, filename: ":memory:", migrations: [] });
          }
          yield* fs.makeDirectory(pluginsDir, { recursive: true });
          return yield* PluginDatabase.open({
            id,
            filename: path.join(pluginsDir, `${id}.sqlite`),
            migrations: plugin.migrations,
          });
        }).pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          // The migrator dies on a failed migration, so defects count as well as failures.
          if (Cause.hasInterruptsOnly(opened.cause)) return yield* Effect.failCause(opened.cause);
          const error = Cause.squash(opened.cause);
          yield* Effect.logError("plugin did not start", { plugin: id, cause: opened.cause });
          startErrors.set(id, error instanceof Error ? error.message : String(error));
          continue;
        }
        if (opened.value.executed.length > 0) {
          yield* Effect.log("plugin migrations ran", {
            plugin: id,
            migrations: opened.value.executed.map(([number, name]) => `${number}_${name}`),
          });
        }
        databases.set(id, opened.value.sql);
      }
    }
    const activeIds = new Set(wanted.filter((id) => databases.has(id)));
    // `resolve` knows only the saved choice; a plugin that failed to start this boot is not running.
    const withStartErrors = (statuses: ReadonlyArray<PluginStatus>) =>
      statuses.map((status) => {
        const startError = startErrors.get(status.id) ?? null;
        return { ...status, active: activeIds.has(status.id), startError };
      });

    const setEnabled = Effect.fn("PluginHost.setEnabled")(function* (id: string, enabled: boolean) {
      if (!plugins.some((plugin) => plugin.id === id))
        return yield* new PluginHostError({ message: `Unknown plugin "${id}".` });
      const next = { ...(yield* read), [id]: enabled };
      const statuses = resolve(plugins, next);
      const missing = statuses.find((status) => status.id === id)?.missing ?? [];
      if (enabled && missing.length > 0)
        return yield* new PluginHostError({
          message: `Enable ${missing.join(", ")} before ${id}.`,
        });
      yield* write(next);
      return withStartErrors(statuses);
    });

    return PluginHost.of({
      activeIds,
      databases,
      statuses: Effect.map(read, (state) => withStartErrors(resolve(plugins, state))),
      setEnabled,
    });
  });

const layer = Layer.effect(PluginHost, make(registry));

const mergeActive = <R>(
  pick: (
    plugin: ServerPlugin<PluginRequirements>,
  ) => Layer.Layer<never, never, R | SqlClient.SqlClient> | undefined,
) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    return registry
      .filter((plugin) => host.activeIds.has(plugin.id))
      .flatMap((plugin) => {
        const layer = pick(plugin);
        if (layer === undefined) return [];
        const sql = host.databases.get(plugin.id);
        return [
          Layer.provide(
            layer,
            sql === undefined
              ? PluginDatabase.layerMemory(plugin.id)
              : Layer.succeed(SqlClient.SqlClient, sql),
          ),
        ];
      })
      .reduce<Layer.Layer<never, never, Exclude<R, SqlClient.SqlClient>>>(
        (merged, next) => Layer.merge(merged, next),
        Layer.empty,
      );
  });

/** The host, its supervisor and every active plugin's services, for the server's layer chain. */
export const layerAll = Layer.unwrap(mergeActive((plugin) => plugin.layer)).pipe(
  Layer.provideMerge(PluginSupervisor.layer(registry.map((plugin) => plugin.id))),
  // The orchestrator's own sink object: a build makes one instance of a layer, so the reactors
  // share its live stream instead of listening on a second sink nothing publishes to.
  Layer.provide(RuntimeLayer.layerEventSink),
  Layer.provideMerge(layer),
);

/** The supervisor's tool and every active plugin's MCP tools, for the `/mcp` server layer. */
export const layerMcp = (register: typeof toolkitRegistration) =>
  Layer.merge(
    register(SupervisorToolkit.SupervisorToolkit, SupervisorToolkit.handlers),
    Layer.unwrap(mergeActive((plugin) => plugin.mcp?.(register))),
  );

/** Every plugin method behind the gateway; the host services come from the server's layer chain. */
const table: PluginRpc.DispatchTable<PluginHost | PluginSupervisor.PluginSupervisor> = {
  ...PluginRpc.defineHandlers(HOST_METHODS)({
    list: () =>
      Effect.gen(function* () {
        return yield* (yield* PluginHost).statuses;
      }),
    setEnabled: ({ id, enabled }) =>
      Effect.gen(function* () {
        return yield* (yield* PluginHost).setEnabled(id, enabled);
      }),
  }),
  ...PluginRpc.defineHandlers(SUPERVISOR_METHODS)({
    // The host's own file answered at boot, so a read failing afterwards is a defect, not a reply.
    status: () =>
      Effect.flatMap(PluginSupervisor.PluginSupervisor, (supervisor) => supervisor.status).pipe(
        Effect.orDie,
      ),
  }),
  ...KanbanHandlers.table,
  ...TelemetryHandlers.table,
};

/** Spread into the WebSocket handlers: the three gateway RPCs and every plugin stream RPC. */
export const handlers = {
  [PLUGIN_GATEWAY_WS_METHODS.read]: (call: PluginMethodCall) =>
    PluginRpc.dispatch("read", table, call),
  [PLUGIN_GATEWAY_WS_METHODS.operate]: (call: PluginMethodCall) =>
    PluginRpc.dispatch("operate", table, call),
  [PLUGIN_GATEWAY_WS_METHODS.settingsWrite]: (call: PluginMethodCall) =>
    PluginRpc.dispatch("settingsWrite", table, call),
  ...KanbanHandlers.streams,
};

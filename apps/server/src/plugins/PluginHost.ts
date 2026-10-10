import { PLUGIN_WS_METHODS, PluginHostError, type PluginStatus } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import type { ServerPlugin } from "./Plugin.ts";
import { type PluginRequirements, registry } from "./registry.ts";

/** `plugins.json` under the state directory: plugin id to saved choice. Absent means enabled. */
const EnabledState = Schema.Record(Schema.String, Schema.Boolean);
type EnabledState = typeof EnabledState.Type;
const decodeEnabledState = Schema.decodeUnknownEffect(Schema.fromJsonString(EnabledState));
const encodeEnabledState = Schema.encodeUnknownEffect(fromJsonStringPretty(EnabledState));

type Registered = Pick<ServerPlugin, "id" | "dependsOn">;

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
  }));
};

export class PluginHost extends Context.Service<
  PluginHost,
  {
    /** Plugins this process runs, decided once at boot. */
    readonly activeIds: ReadonlySet<string>;
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

    const activeIds = new Set(
      resolve(plugins, yield* read)
        .filter((status) => status.active)
        .map((status) => status.id),
    );

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
      return statuses;
    });

    return PluginHost.of({
      activeIds,
      statuses: Effect.map(read, (state) => resolve(plugins, state)),
      setEnabled,
    });
  });

const layer = Layer.effect(PluginHost, make(registry));

const mergeActive = (
  pick: (
    plugin: ServerPlugin<PluginRequirements>,
  ) => Layer.Layer<never, never, PluginRequirements> | undefined,
) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    return registry
      .filter((plugin) => host.activeIds.has(plugin.id))
      .flatMap((plugin) => pick(plugin) ?? [])
      .reduce<Layer.Layer<never, never, PluginRequirements>>(
        (merged, next) => Layer.merge(merged, next),
        Layer.empty,
      );
  });

/** The host plus every active plugin's services, for the server's layer chain. */
export const layerAll = Layer.unwrap(mergeActive((plugin) => plugin.layer)).pipe(
  Layer.provideMerge(layer),
);

/** Every active plugin's MCP tools, for the `/mcp` server layer. */
export const layerMcp = Layer.unwrap(mergeActive((plugin) => plugin.mcp));

/** Spread into the WebSocket handlers; the host service comes from the server's layer chain. */
export const handlers = {
  [PLUGIN_WS_METHODS.pluginsList]: () =>
    Effect.gen(function* () {
      return yield* (yield* PluginHost).statuses;
    }),
  [PLUGIN_WS_METHODS.pluginsSetEnabled]: ({
    id,
    enabled,
  }: {
    readonly id: string;
    readonly enabled: boolean;
  }) =>
    Effect.gen(function* () {
      return yield* (yield* PluginHost).setEnabled(id, enabled);
    }),
};

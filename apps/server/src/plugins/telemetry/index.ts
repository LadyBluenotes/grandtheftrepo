import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as Reactor from "./reactor.ts";
import { heartbeat } from "./sweep.ts";
import * as Telemetry from "./Telemetry.ts";

// Neither fails in a state the plugin can run in: a database that cannot take the reactor's
// tables, or a second sweep under this plugin's own name, are defects.
const start = Effect.gen(function* () {
  yield* PluginReactor.start({ plugin: "telemetry", from: "start", handlers: Reactor.handlers });
  yield* (yield* PluginSupervisor.PluginSupervisor).register(heartbeat);
}).pipe(Effect.orDie);

/**
 * Token usage per provider turn, from `provider-turn.updated`. The template
 * plugin: it uses each host seam once (database, reactor, sweep, RPC, MCP tool,
 * settings panel). The measures over its table arrive in #1.
 */
export const plugin = {
  id: "telemetry",
  dependsOn: [],
  migrations,
  layer: Layer.effectDiscard(start).pipe(Layer.provideMerge(Telemetry.layer)),
  mcp: (register) => register(Mcp.TelemetryToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

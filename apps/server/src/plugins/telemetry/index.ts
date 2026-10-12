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
const make = Effect.gen(function* () {
  const reactor = yield* PluginReactor.start({
    plugin: "telemetry",
    from: "start",
    handlers: Reactor.handlers,
  });
  yield* (yield* PluginSupervisor.PluginSupervisor).register(heartbeat);
  // The measures read the reactor's tables, so each request waits for it to catch up.
  return yield* Telemetry.make(reactor.drain);
}).pipe(Effect.orDie);

/**
 * Efficiency measures over a project's window, computed from the plugin's own
 * tables, which its reactor fills from the event log. The template plugin: it
 * uses each host seam once (database, reactor, sweep, RPC, MCP tool, settings
 * panel).
 */
export const plugin = {
  id: "telemetry",
  dependsOn: [],
  migrations,
  layer: Layer.effect(Telemetry.Telemetry, make),
  mcp: (register) => register(Mcp.TelemetryToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

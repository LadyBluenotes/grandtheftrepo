import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as BudgetStore from "./budgets/BudgetStore.ts";
import * as BudgetSweep from "./budgets/BudgetSweep.ts";
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
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  yield* supervisor.register(heartbeat);
  // The measures read the reactor's tables, so each request waits for it to catch up.
  const telemetry = yield* Telemetry.make(reactor.drain);
  yield* supervisor.register(yield* BudgetSweep.sweep(telemetry.measures));
  return telemetry;
}).pipe(Effect.orDie);

/**
 * Efficiency measures over a project's window, computed from the plugin's own
 * tables, which its reactor fills from the event log, and budgets on them that
 * a sweep checks. The template plugin: it uses each host seam once (database,
 * reactor, sweep, RPC, MCP tool, settings panel).
 */
export const plugin = {
  id: "telemetry",
  dependsOn: [],
  migrations,
  layer: Layer.effect(Telemetry.Telemetry, make).pipe(Layer.provideMerge(BudgetStore.layer)),
  mcp: (register) => register(Mcp.TelemetryToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

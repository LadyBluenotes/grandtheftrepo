import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as BudgetStore from "./budgets/BudgetStore.ts";
import * as BudgetSweep from "./budgets/BudgetSweep.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as Reactor from "./reactor.ts";
import * as ReportMcp from "./report/mcp.ts";
import * as ReportService from "./report/ReportService.ts";
import * as WeeklyReportSeed from "./report/WeeklyReportSeed.ts";
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
  // Once the server is up, so the task service and projects are ready.
  yield* forkParked(
    WeeklyReportSeed.seed.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("telemetry: weekly reports could not be seeded", { cause }),
      ),
    ),
  );
  // The measures and the report read the reactor's tables, so each request waits for it to catch up.
  const telemetry = yield* Telemetry.make(reactor.drain);
  yield* supervisor.register(yield* BudgetSweep.sweep(telemetry.measures));
  return Context.make(Telemetry.Telemetry, telemetry).pipe(
    Context.add(ReportService.ReportService, yield* ReportService.make(telemetry, reactor.drain)),
  );
}).pipe(Effect.orDie);

/**
 * Efficiency measures over a project's window, computed from the plugin's own
 * tables, which its reactor fills from the event log, budgets on them that a
 * sweep checks, and an activity report over a range that a weekly scheduled task
 * posts in each project. The template plugin: it uses each host seam (database,
 * reactor, sweep, RPC, MCP tool, settings panel).
 */
export const plugin = {
  id: "telemetry",
  dependsOn: [],
  migrations,
  layer: Layer.effectContext(make).pipe(Layer.provideMerge(BudgetStore.layer)),
  mcp: (register) =>
    Layer.merge(
      register(Mcp.TelemetryToolkit, Mcp.handlers),
      register(ReportMcp.ReportToolkit, ReportMcp.handlers),
    ),
} satisfies ServerPlugin<unknown>;

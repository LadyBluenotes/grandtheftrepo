import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
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
  yield* (yield* PluginSupervisor.PluginSupervisor).register(heartbeat);
  // Once the server is up, so the task service and projects are ready.
  yield* forkParked(
    WeeklyReportSeed.seed.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("telemetry: weekly reports could not be seeded", { cause }),
      ),
    ),
  );
  // The measures read the reactor's tables, so each request waits for it to catch up.
  return yield* Telemetry.make(reactor.drain);
}).pipe(Effect.orDie);

/**
 * Efficiency measures over a project's window, computed from the plugin's own
 * tables, which its reactor fills from the event log, and an activity report
 * over a range that a weekly scheduled task posts in each project. The template
 * plugin: it uses each host seam (database, reactor, sweep, RPC, MCP tool,
 * settings panel).
 */
export const plugin = {
  id: "telemetry",
  dependsOn: [],
  migrations,
  layer: ReportService.layer.pipe(Layer.provideMerge(Layer.effect(Telemetry.Telemetry, make))),
  mcp: (register) =>
    Layer.merge(
      register(Mcp.TelemetryToolkit, Mcp.handlers),
      register(ReportMcp.ReportToolkit, ReportMcp.handlers),
    ),
} satisfies ServerPlugin<unknown>;

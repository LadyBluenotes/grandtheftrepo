import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginReactor from "../PluginReactor.ts";
import * as AdherenceReactor from "./AdherenceReactor.ts";
import * as AdherenceService from "./AdherenceService.ts";
import { migrations } from "./migrations.ts";
import * as Mcp from "./mcp.ts";
import * as TierMapService from "./TierMapService.ts";
import * as TierSelectionService from "./TierSelectionService.ts";

// The reactor's cursor tables go in the database the host just migrated, so a failure here is a defect.
const adherence = Layer.effect(
  AdherenceService.AdherenceService,
  Effect.gen(function* () {
    const reactor = yield* PluginReactor.start({
      plugin: "routing",
      from: "start",
      handlers: AdherenceReactor.handlers,
    });
    // The measure reads the rows the reactor writes, so each request waits for it to catch up.
    return yield* AdherenceService.make(reactor.drain);
  }).pipe(Effect.orDie),
);

/**
 * Which provider instance and model does which kind of work: three tiers, `cheap`, `standard` and
 * `strong`, set for the environment and overridable per project, in the plugin's own database.
 * Launchers pick a tier per task class and escalate it after failed runs through
 * `TierSelectionService`. A reactor compares each recommended thread's first run with the
 * recommendation, and `routing.adherence` reports how often they matched.
 */
export const plugin = {
  id: "routing",
  dependsOn: [],
  migrations,
  layer: Layer.mergeAll(
    TierSelectionService.layer.pipe(Layer.provideMerge(TierMapService.layer)),
    adherence,
  ),
  mcp: (register) => register(Mcp.RoutingToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

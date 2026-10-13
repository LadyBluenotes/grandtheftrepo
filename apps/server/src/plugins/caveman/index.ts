import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import { fromService } from "../Readiness.ts";
import * as CavemanService from "./CavemanService.ts";
import * as LearnSweep from "./learn/sweep.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as Checks from "./readiness.ts";

// Neither fails in a state the plugin can run in: the database was just migrated, and the sweep's
// name is this plugin's own.
const start = Effect.gen(function* () {
  yield* (yield* PluginSupervisor.PluginSupervisor).register(yield* LearnSweep.make);
}).pipe(Effect.orDie);

/**
 * Shows whether each provider instance's traffic goes through caveman's proxy, and runs caveman's
 * own `enable` and `disable` commands on request. Its database keeps the newest `caveman learn`
 * reports, imported by the `caveman/learn` sweep; it writes no other file.
 */
export const plugin = {
  id: "caveman",
  dependsOn: [],
  migrations,
  layer: Layer.merge(Layer.effectDiscard(start), Checks.layer).pipe(
    Layer.provideMerge(CavemanService.layer),
  ),
  mcp: (register) => register(Mcp.CavemanToolkit, Mcp.handlers),
  readiness: fromService(Checks.CavemanReadiness),
} satisfies ServerPlugin<unknown>;

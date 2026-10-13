import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as PluginSupervisor from "../PluginSupervisor.ts";
import * as DeliverySweep from "./DeliverySweep.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";
import * as Ponytail from "./ponytail.ts";

// Registering fails only on a second sweep under this plugin's own name, a defect.
const start = Effect.gen(function* () {
  yield* Ponytail.seed();
  yield* (yield* PluginSupervisor.PluginSupervisor).register(yield* DeliverySweep.make);
}).pipe(Effect.orDie);

/**
 * Reviewed working rules per project, rendered as one marked block per policy into the
 * instruction file each agent reads from the user's home, with a check that the block is intact.
 * A supervisor sweep installs accepted policies the agents lack, between runs. The built-in
 * `ponytail` policy is seeded on start when it does not exist.
 */
export const plugin = {
  id: "policy",
  dependsOn: [],
  migrations,
  layer: Layer.effectDiscard(start).pipe(Layer.provideMerge(PolicyService.layer)),
  mcp: (register) => register(Mcp.PolicyToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

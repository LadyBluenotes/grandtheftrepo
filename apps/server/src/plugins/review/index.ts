import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as ReviewGate from "./ReviewGate.ts";
import * as ReviewInvalidationSweep from "./ReviewInvalidationSweep.ts";
import * as ReviewRequests from "./ReviewRequests.ts";
import * as VerdictStore from "./VerdictStore.ts";

/**
 * A reviewing agent's typed verdict on one checkpoint of another thread: approve, or send it back
 * with one of six failure modes. A verdict that sends work back records a correction in the
 * learning plugin, so the plugin runs only while learning does. A review request names the
 * checkpoint it asks about; the invalidation sweep marks it stale once the thread moves past that
 * checkpoint, and `ReviewGate` tells a ticket's completion whether review lets it finish.
 */
export const plugin = {
  id: "review",
  dependsOn: ["learning"],
  migrations,
  // A second sweep under this plugin's own name is a defect, not a state the plugin can run in.
  layer: Layer.effectDiscard(ReviewInvalidationSweep.register.pipe(Effect.orDie)).pipe(
    Layer.provideMerge(Layer.mergeAll(VerdictStore.layer, ReviewRequests.layer, ReviewGate.layer)),
  ),
  mcp: (register) => register(Mcp.ReviewToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

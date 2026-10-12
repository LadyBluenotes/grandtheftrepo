import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import { migrations } from "./migrations.ts";
import * as Mcp from "./mcp.ts";
import * as TierMapService from "./TierMapService.ts";
import * as TierSelectionService from "./TierSelectionService.ts";

/**
 * Which provider instance and model does which kind of work: three tiers, `cheap`, `standard` and
 * `strong`, set for the environment and overridable per project, in the plugin's own database.
 * Launchers pick a tier per task class and escalate it after failed runs through
 * `TierSelectionService`.
 */
export const plugin = {
  id: "routing",
  dependsOn: [],
  migrations,
  layer: TierSelectionService.layer.pipe(Layer.provideMerge(TierMapService.layer)),
  mcp: (register) => register(Mcp.RoutingToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

import type { ServerPlugin } from "../Plugin.ts";
import { migrations } from "./migrations.ts";
import * as Mcp from "./mcp.ts";
import * as TierMapService from "./TierMapService.ts";

/**
 * Which provider instance and model does which kind of work: three tiers, `cheap`, `standard` and
 * `strong`, set for the environment and overridable per project, in the plugin's own database.
 */
export const plugin = {
  id: "routing",
  dependsOn: [],
  migrations,
  layer: TierMapService.layer,
  mcp: (register) => register(Mcp.RoutingToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

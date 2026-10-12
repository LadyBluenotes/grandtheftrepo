import type { ServerPlugin } from "../Plugin.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as PolicyService from "./PolicyService.ts";

/**
 * Reviewed working rules per project, rendered as one marked block per policy into the
 * instruction file each agent reads from the user's home, with a check that the block is intact.
 */
export const plugin = {
  id: "policy",
  dependsOn: [],
  migrations,
  layer: PolicyService.layer,
  mcp: (register) => register(Mcp.PolicyToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

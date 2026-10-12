import type { ServerPlugin } from "../Plugin.ts";
import * as CavemanService from "./CavemanService.ts";
import * as Mcp from "./mcp.ts";

/**
 * Shows whether each provider instance's traffic goes through caveman's proxy, and runs caveman's
 * own `enable` and `disable` commands on request. It writes no file and keeps no database.
 */
export const plugin = {
  id: "caveman",
  dependsOn: [],
  layer: CavemanService.layer,
  mcp: (register) => register(Mcp.CavemanToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

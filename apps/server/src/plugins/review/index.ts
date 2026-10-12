import type { ServerPlugin } from "../Plugin.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as VerdictStore from "./VerdictStore.ts";

/**
 * A reviewing agent's typed verdict on one checkpoint of another thread: approve, or send it back
 * with one of six failure modes. A verdict that sends work back records a correction in the
 * learning plugin, so the plugin runs only while learning does.
 */
export const plugin = {
  id: "review",
  dependsOn: ["learning"],
  migrations,
  layer: VerdictStore.layer,
  mcp: (register) => register(Mcp.ReviewToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

import type { ServerPlugin } from "../Plugin.ts";
import * as KanbanAutomation from "./KanbanAutomation.ts";
import * as Mcp from "./mcp.ts";

/**
 * A kanban board per project: issues and decisions as files under the
 * project's wiki folder, status automation from thread events, and two MCP
 * tools so agents can file and read tickets.
 */
export const plugin = {
  id: "kanban",
  dependsOn: [],
  layer: KanbanAutomation.layer,
  mcp: (register) => register(Mcp.KanbanToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

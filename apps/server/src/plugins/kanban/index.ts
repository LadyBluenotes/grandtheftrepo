import type { ServerPlugin } from "../Plugin.ts";
import * as KanbanAutomation from "./KanbanAutomation.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";

/**
 * A kanban board per project: issues and decisions as files under the
 * project's wiki folder, status automation from thread events, and MCP tools
 * so agents can file and read tickets. Its own database holds the emergency
 * stop; a sweep raises a host attention flag when two agents write the same
 * project, and `kanban.attention.list` shows a project's flags with its
 * threads' pending requests above the board.
 */
export const plugin = {
  id: "kanban",
  dependsOn: [],
  migrations,
  layer: KanbanAutomation.layer,
  mcp: (register) => register(Mcp.KanbanToolkit, Mcp.handlers),
} satisfies ServerPlugin<unknown>;

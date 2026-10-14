import * as Layer from "effect/Layer";

import type { ServerPlugin } from "../Plugin.ts";
import { fromService } from "../Readiness.ts";
import * as FindingMcp from "./findings/mcp.ts";
import * as KanbanAutomation from "./KanbanAutomation.ts";
import * as Mcp from "./mcp.ts";
import { migrations } from "./migrations.ts";
import * as Checks from "./readiness.ts";

/**
 * A kanban board per project: issues and decisions as files under the
 * project's wiki folder, status automation from thread events, and MCP tools
 * so agents can file and read tickets. Its own database holds the emergency
 * stop and spec attempts; a sweep raises a host attention flag when two agents
 * write the same project, a reactor validates the spec a drafting thread
 * wrote once its run ends, and `kanban.attention.list` shows a project's flags
 * with its threads' pending requests above the board. Findings, problems an agent found outside
 * its task, live on issues and have tools of their own.
 */
export const plugin = {
  id: "kanban",
  dependsOn: [],
  migrations,
  layer: KanbanAutomation.layer,
  mcp: (register) =>
    Layer.merge(
      register(Mcp.KanbanToolkit, Mcp.handlers),
      register(FindingMcp.FindingToolkit, FindingMcp.handlers),
    ),
  readiness: fromService(Checks.KanbanReadiness),
} satisfies ServerPlugin<unknown>;

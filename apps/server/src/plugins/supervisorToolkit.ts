import { OrchestratorMcpFailure, SupervisorStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

const SupervisorStatusTool = Tool.make("supervisor_status", {
  description:
    "Report the plugin supervisor: its tick interval, whether it runs dry, the sweeps registered in the order they run, and the latest tick with each sweep's status (ok, failed, timed_out), counts and error.",
  // No `parameters`: an explicit empty Schema.Struct({}) is not a valid MCP input schema.
  success: SupervisorStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const SupervisorToolkit = Toolkit.make(SupervisorStatusTool);

/** The supervisor is the host's, always present, so the layer requires it outright. */
export const handlers = McpToolAccess.toLayer(
  SupervisorToolkit,
  Effect.map(PluginSupervisor.PluginSupervisor, (supervisor) => ({
    supervisor_status: McpToolAccess.reads(() =>
      supervisor.status.pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not read the supervisor summary.",
            }),
        ),
      ),
    ),
  })),
);

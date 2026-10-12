import {
  OrchestratorMcpFailure,
  TelemetryMeasuresInput,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as Telemetry from "./Telemetry.ts";

const TelemetryMeasuresTool = Tool.make("telemetry_measures", {
  description:
    "Report a project's token usage between two ISO instants, from the telemetry plugin. Until the measures are built it answers state unavailable with the reason.",
  parameters: TelemetryMeasuresInput,
  success: TelemetryMeasuresResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const TelemetryToolkit = Toolkit.make(TelemetryMeasuresTool);

/**
 * The service is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the service is there.
 */
export const handlers = McpToolAccess.toLayer(
  TelemetryToolkit,
  Effect.map(Effect.serviceOption(Telemetry.Telemetry), (option) => {
    const telemetry = Option.match(option, {
      onNone: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The telemetry plugin is not active.",
          }),
        ),
      onSome: Effect.succeed,
    });
    return {
      telemetry_measures: McpToolAccess.reads((input) =>
        Effect.flatMap(telemetry, (t) => t.measures(input)),
      ),
    };
  }),
);

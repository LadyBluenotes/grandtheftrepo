import {
  OrchestratorMcpFailure,
  TelemetryReportInput,
  TelemetryReportResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ReportService from "./ReportService.ts";

const TelemetryReportTool = Tool.make("telemetry_report", {
  description:
    "Report a project's activity over a range: what was delivered, review findings, decisions, knowledge and prompt changes, failures, pull requests, what is unresolved, what needs attention, and efficiency measures. from (inclusive) and to (exclusive) are ISO instants in UTC; omit both for the last seven whole UTC days. Returns the report and the same report as a self-contained html page to pass unchanged to html_render. A section whose plugin is off answers state unavailable, naming the plugin.",
  parameters: TelemetryReportInput,
  success: TelemetryReportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ReportToolkit = Toolkit.make(TelemetryReportTool);

/** Reads the service when the handlers are built, as `../mcp.ts` does, for the same reason. */
export const handlers = McpToolAccess.toLayer(
  ReportToolkit,
  Effect.map(Effect.serviceOption(ReportService.ReportService), (option) => {
    const reports = Option.match(option, {
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
      telemetry_report: McpToolAccess.reads((input) =>
        Effect.flatMap(reports, (service) => service.report(input)).pipe(
          Effect.catchTags({
            TelemetryError: (error) =>
              Effect.fail(
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
              ),
          }),
        ),
      ),
    };
  }),
);

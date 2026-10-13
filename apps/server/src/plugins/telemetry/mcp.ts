import {
  OrchestratorMcpFailure,
  type TelemetryError,
  TelemetryBudgetsInput,
  TelemetryBudgetsResult,
  TelemetryMeasuresInput,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BudgetStore from "./budgets/BudgetStore.ts";
import * as Telemetry from "./Telemetry.ts";

const TelemetryMeasuresTool = Tool.make("telemetry_measures", {
  description:
    "Report a project's efficiency measures over a window: from (inclusive) and to (exclusive), ISO instants in UTC. With tier (cheap, standard or strong), only the runs on that routing tier's model count. Each measure has a value with its unit and direction, how many turns, runs or threads contributed, and the event fields it read; a measure whose inputs are missing answers state unavailable with the reason instead of a value.",
  parameters: TelemetryMeasuresInput,
  success: TelemetryMeasuresResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const TelemetryBudgetsTool = Tool.make("telemetry_budgets", {
  description:
    "List the budgets: limits on one efficiency measure for one routing tier, for one project or every project, judged over the last seven whole UTC days. Each has its threshold and direction, the minimum sample it judges, whether it is enabled, its state (breach or ok) and the newest breach or recovery of each project it judges. With projectId, only the budgets that judge that project.",
  parameters: TelemetryBudgetsInput,
  success: TelemetryBudgetsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const TelemetryToolkit = Toolkit.make(TelemetryMeasuresTool, TelemetryBudgetsTool);

const inactive = Effect.fail(
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The telemetry plugin is not active.",
  }),
);

const failure = {
  TelemetryError: (error: TelemetryError) =>
    Effect.fail(
      new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
};

/**
 * The services are read when the handlers are built, not declared as tool dependencies: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the services are there.
 */
export const handlers = McpToolAccess.toLayer(
  TelemetryToolkit,
  Effect.gen(function* () {
    const telemetry = Option.match(yield* Effect.serviceOption(Telemetry.Telemetry), {
      onNone: () => inactive,
      onSome: Effect.succeed,
    });
    const budgets = Option.match(yield* Effect.serviceOption(BudgetStore.BudgetStore), {
      onNone: () => inactive,
      onSome: Effect.succeed,
    });
    return {
      telemetry_measures: McpToolAccess.reads((input) =>
        Effect.flatMap(telemetry, (t) => t.measures(input)).pipe(Effect.catchTags(failure)),
      ),
      telemetry_budgets: McpToolAccess.reads((input) =>
        Effect.flatMap(budgets, (store) => store.list(input)).pipe(Effect.catchTags(failure)),
      ),
    };
  }),
);

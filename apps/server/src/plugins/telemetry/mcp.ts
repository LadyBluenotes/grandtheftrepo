import {
  OrchestratorMcpFailure,
  type TelemetryError,
  TelemetryBudgetsInput,
  TelemetryBudgetsResult,
  TelemetryExtractionCandidatesInput,
  TelemetryExtractionCandidatesResult,
  TelemetryMeasuresInput,
  TelemetryMeasuresResult,
  TelemetryToolOutputInput,
  TelemetryToolOutputResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Tool, Toolkit } from "effect/ai";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BudgetStore from "./budgets/BudgetStore.ts";
import { extractionCandidatesOf } from "./measures/repeatedWork.ts";
import { toolOutputOf } from "./measures/toolOutput.ts";
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

const TelemetryToolOutputTool = Tool.make("telemetry_tool_output", {
  description:
    "Report which tools produce the most output in a project's window: from (inclusive) and to (exclusive), ISO instants in UTC, over every run and over the calls a provider's subagent makes, which belong to no run. byTool lists each tool (a tool's name, command:<program>, file_search or web_search) with its calls, estimated tokens, share of the total and median and 95th percentile per call, largest first. largest lists the ten biggest single results with their tool, thread, run (null for a subagent's call) and item. Sizes are estimates, characters over four with an inline image as 1,500, not a tokenizer's counts. Check this before a long task to see which of your tools are expensive. With no tool items in the window both lists are empty and missingReason says why.",
  parameters: TelemetryToolOutputInput,
  success: TelemetryToolOutputResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const TelemetryExtractionCandidatesTool = Tool.make("telemetry_extraction_candidates", {
  description:
    "List the deterministic work a project's agents repeat, which a script, a hook, an MCP tool, a scheduled task, a context file or a skill could do instead of model tokens, over a window: from (inclusive) and to (exclusive), ISO instants in UTC, every run and a provider's subagent's calls counted. Each candidate is one tool call shape, or two to six in a row, that runs in at least three threads repeated: its steps (a command line with paths relative to the project, integers as <n> and quoted strings as <str>; a tool's name with its pattern and path, or its input's keys; <path> and <pattern> where the occurrences differ; script:<program>:<digest prefix> for a script written into the command line or a command line of 512 characters or more, matching only the same script), threads, occurrences, the share whose raw inputs were identical, estimated tokens (characters over four, output and input), the form it suits, and one example's thread, run (null for a subagent's calls) and items; a script's text is never returned. Most estimated tokens first; limit, 1 to 20, defaults to 20. Read this to propose a script, hook or skill in a thread; it changes nothing. With fewer than three threads in the window the list is empty and missingReason says why.",
  parameters: TelemetryExtractionCandidatesInput,
  success: TelemetryExtractionCandidatesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const TelemetryToolkit = Toolkit.make(
  TelemetryMeasuresTool,
  TelemetryBudgetsTool,
  TelemetryToolOutputTool,
  TelemetryExtractionCandidatesTool,
);

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
      telemetry_tool_output: McpToolAccess.reads((input) =>
        Effect.flatMap(telemetry, (t) => t.measures(input)).pipe(
          Effect.map(toolOutputOf),
          Effect.catchTags(failure),
        ),
      ),
      telemetry_extraction_candidates: McpToolAccess.reads(({ limit, ...window }) =>
        Effect.flatMap(telemetry, (t) => t.measures(window)).pipe(
          Effect.map((measures) => extractionCandidatesOf(measures, limit)),
          Effect.catchTags(failure),
        ),
      ),
      telemetry_budgets: McpToolAccess.reads((input) =>
        Effect.flatMap(budgets, (store) => store.list(input)).pipe(Effect.catchTags(failure)),
      ),
    };
  }),
);

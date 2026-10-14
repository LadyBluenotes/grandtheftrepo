import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";
import { RoutingTier } from "./tier.ts";

/**
 * A project's window: `from` inclusive, `to` exclusive, both instants in UTC. With `tier`, only
 * the runs on that routing tier's model for the project count.
 */
export const TelemetryMeasuresInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
  tier: Schema.optional(RoutingTier),
});
export type TelemetryMeasuresInput = typeof TelemetryMeasuresInput.Type;

/** Which side of a value is better. */
export const TelemetryDirection = Schema.Literals(["lower_is_better", "higher_is_better"]);
export type TelemetryDirection = typeof TelemetryDirection.Type;

/**
 * One tool's share of a window's tool output. Sizes are estimates, not a tokenizer's counts:
 * characters over four, with an inline image as a fixed 1,500.
 */
export const TelemetryToolOutput = Schema.Struct({
  /** A dynamic tool's name, `command:<program>`, `file_search` or `web_search`. */
  tool: Schema.String,
  calls: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  /** This tool's estimated tokens over the window's total, so the shares sum to one. */
  share: Schema.Finite,
  /** Nearest-rank percentiles of this tool's calls, in estimated tokens. */
  p50: NonNegativeInt,
  p95: NonNegativeInt,
});
export type TelemetryToolOutput = typeof TelemetryToolOutput.Type;

/** One tool result among a window's largest, with where to find it. */
export const TelemetryLargestOutput = Schema.Struct({
  tool: Schema.String,
  threadId: Schema.String,
  /** Null for a call a provider's subagent made, which belongs to no run. */
  runId: Schema.NullOr(Schema.String),
  itemId: Schema.String,
  estimatedTokens: NonNegativeInt,
});
export type TelemetryLargestOutput = typeof TelemetryLargestOutput.Type;

/**
 * Where repeated deterministic work should live instead of in model tokens. `script`: a command
 * sequence in the repo. `hook`: a command the provider runs after an edit. `mcp_tool`: one server
 * tool returning what several reads or searches gather. `scheduled_task`: a prompt on a timer.
 * `context_file`: facts written once into the project's instruction file. `skill`: a written
 * procedure the agent follows.
 */
export const TelemetryExtractionForm = Schema.Literals([
  "script",
  "hook",
  "mcp_tool",
  "scheduled_task",
  "context_file",
  "skill",
]);
export type TelemetryExtractionForm = typeof TelemetryExtractionForm.Type;

/**
 * A tool call shape, or two to six in a row, repeated in at least three threads. A step is the
 * command line with paths made relative to the project, integers as `<n>` and quoted strings as
 * `<str>`, or a dynamic tool's name with its pattern and path, or its input's keys. `<path>` and
 * `<pattern>` in a step mean the occurrences differ there, which only a procedure has, and only
 * when two or more different steps differ. A script, an interpreter running one written into the
 * command line or any command line of 512 characters or more, is
 * `script:<program>:<digest prefix>` and matches only the same script.
 */
export const TelemetryExtractionCandidate = Schema.Struct({
  /** The same for the same steps in any window. */
  id: Schema.String,
  kind: Schema.Literals(["step", "procedure"]),
  steps: Schema.Array(Schema.String),
  threads: NonNegativeInt,
  occurrences: NonNegativeInt,
  /** The share of occurrences whose raw inputs match the most common ones exactly. */
  deterministicRatio: Schema.Finite,
  /** Output and input of every occurrence, in estimated tokens: characters over four. */
  estimatedTokens: NonNegativeInt,
  form: TelemetryExtractionForm,
  /**
   * One occurrence to look at. `runId` is null for a provider's subagent's calls. `scripts` holds,
   * for each step, a script's command line as stored, at most its first 512 characters, so a
   * longer script is cut short; null for a step that is not a script.
   */
  example: Schema.Struct({
    threadId: Schema.String,
    runId: Schema.NullOr(Schema.String),
    itemIds: Schema.Array(Schema.String),
    scripts: Schema.Array(Schema.NullOr(Schema.String)),
  }),
});
export type TelemetryExtractionCandidate = typeof TelemetryExtractionCandidate.Type;

/** The rows behind a measure's value, for the measures that have them. */
export const TelemetryMeasureDetail = Schema.Struct({
  /** Every tool in the window, largest total first. */
  byTool: Schema.optional(Schema.Array(TelemetryToolOutput)),
  /** The window's ten largest single results, largest first. */
  largest: Schema.optional(Schema.Array(TelemetryLargestOutput)),
  /** The window's twenty costliest extraction candidates, most estimated tokens first. */
  candidates: Schema.optional(Schema.Array(TelemetryExtractionCandidate)),
});
export type TelemetryMeasureDetail = typeof TelemetryMeasureDetail.Type;

/**
 * One measure over a window. `unavailable` is an answer, not an error: `value` is then null and
 * `missingReason` says why. An `ok` value never stands in for missing data.
 */
export const TelemetryMeasure = Schema.Struct({
  measure: Schema.String,
  state: Schema.Literals(["ok", "unavailable"]),
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.Literals(["ratio", "tokens", "seconds", "count", "usd"]),
  direction: TelemetryDirection,
  /** How many turns, runs or threads contributed. */
  sampleSize: NonNegativeInt,
  /** Why the measure is unavailable, or what an `ok` value had to leave out. */
  missingReason: Schema.NullOr(Schema.String),
  /** The event fields it read, such as `providerTurn.tokenUsage.outputTokens`. */
  provenance: Schema.Array(Schema.String),
  /** The rows the value comes from, set by the measures that keep them. */
  detail: Schema.optional(TelemetryMeasureDetail),
});
export type TelemetryMeasure = typeof TelemetryMeasure.Type;

/** Every measure, in a fixed order. */
export const TelemetryMeasuresResult = Schema.Array(TelemetryMeasure);
export type TelemetryMeasuresResult = typeof TelemetryMeasuresResult.Type;

/** A project's window, as `TelemetryMeasuresInput` without the tier: tool output counts every run. */
export const TelemetryToolOutputInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
});
export type TelemetryToolOutputInput = typeof TelemetryToolOutputInput.Type;

/**
 * Tool output over a window: each tool's total and the largest results. Both lists are empty
 * and `missingReason` says why when the window has no tool items or the tables are not ready.
 */
export const TelemetryToolOutputResult = Schema.Struct({
  byTool: Schema.Array(TelemetryToolOutput),
  largest: Schema.Array(TelemetryLargestOutput),
  missingReason: Schema.NullOr(Schema.String),
});
export type TelemetryToolOutputResult = typeof TelemetryToolOutputResult.Type;

/** A project's window, every run counted, and how many candidates to list: 1 to 20, 20 when left out. */
export const TelemetryExtractionCandidatesInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type TelemetryExtractionCandidatesInput = typeof TelemetryExtractionCandidatesInput.Type;

/**
 * Repeated deterministic work over a window, most estimated tokens first. Empty with the reason
 * when the window has fewer than three threads or the tables are not ready.
 */
export const TelemetryExtractionCandidatesResult = Schema.Struct({
  candidates: Schema.Array(TelemetryExtractionCandidate),
  missingReason: Schema.NullOr(Schema.String),
});
export type TelemetryExtractionCandidatesResult = typeof TelemetryExtractionCandidatesResult.Type;

/** A limit on one measure for one routing tier, judged over the last seven whole UTC days. */
export const TelemetryBudget = Schema.Struct({
  id: Schema.Int,
  measure: Schema.String,
  tier: RoutingTier,
  /** In the measure's unit. */
  threshold: Schema.Finite,
  /** `lower_is_better` is breached above the threshold, `higher_is_better` below it. */
  direction: TelemetryDirection,
  /** Null judges every project, one by one. */
  projectId: Schema.NullOr(ProjectId),
  /** A window with fewer samples is never judged. */
  minSample: NonNegativeInt,
  enabled: Schema.Boolean,
});
export type TelemetryBudget = typeof TelemetryBudget.Type;

/** A budget crossing its threshold in one project's window, or coming back inside it. */
export const TelemetryBudgetEvent = Schema.Struct({
  id: Schema.Int,
  budgetId: Schema.Int,
  projectId: ProjectId,
  kind: Schema.Literals(["breach", "recovery"]),
  windowFrom: IsoDateTime,
  windowTo: IsoDateTime,
  value: Schema.Finite,
  threshold: Schema.Finite,
  sampleSize: NonNegativeInt,
  occurredAt: IsoDateTime,
});
export type TelemetryBudgetEvent = typeof TelemetryBudgetEvent.Type;

export const TelemetryBudgetWithState = Schema.Struct({
  ...TelemetryBudget.fields,
  /** `breach` while the newest event of any project in `latest` is a breach. */
  state: Schema.Literals(["ok", "breach"]),
  /** The newest event of each project the budget judges, or of the one asked for. */
  latest: Schema.Array(TelemetryBudgetEvent),
});
export type TelemetryBudgetWithState = typeof TelemetryBudgetWithState.Type;

/** Every budget, or with `projectId` the ones that judge that project. */
export const TelemetryBudgetsInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type TelemetryBudgetsInput = typeof TelemetryBudgetsInput.Type;

export const TelemetryBudgetsResult = Schema.Array(TelemetryBudgetWithState);
export type TelemetryBudgetsResult = typeof TelemetryBudgetsResult.Type;

/**
 * A budget's fields as a client sends them. Measure, tier, threshold, direction and minimum sample
 * are checked by the server, which refuses a bad one with `Budget is invalid: <field>`.
 */
const TelemetryBudgetFields = {
  measure: Schema.String,
  tier: Schema.String,
  threshold: Schema.Number,
  direction: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  minSample: Schema.Number,
  enabled: Schema.Boolean,
};

/**
 * A change to one budget: only the fields given change, so two clients editing different fields
 * of one budget do not undo each other.
 */
const TelemetryBudgetPatch = Schema.Struct({
  id: Schema.Int,
  measure: Schema.optional(TelemetryBudgetFields.measure),
  tier: Schema.optional(TelemetryBudgetFields.tier),
  threshold: Schema.optional(TelemetryBudgetFields.threshold),
  direction: Schema.optional(TelemetryBudgetFields.direction),
  projectId: Schema.optional(TelemetryBudgetFields.projectId),
  minSample: Schema.optional(TelemetryBudgetFields.minSample),
  enabled: Schema.optional(TelemetryBudgetFields.enabled),
});
export type TelemetryBudgetPatch = typeof TelemetryBudgetPatch.Type;

/**
 * With `id`, a patch of that budget; without, a new budget with every field. The patch is tried
 * first: a new budget has no `id` to match it.
 */
export const TelemetryBudgetsSetInput = Schema.Union([
  TelemetryBudgetPatch,
  Schema.Struct(TelemetryBudgetFields),
]);
export type TelemetryBudgetsSetInput = typeof TelemetryBudgetsSetInput.Type;

/** A project's budget events that occurred in `[from, to)`. */
export const TelemetryBudgetEventsInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
});
export type TelemetryBudgetEventsInput = typeof TelemetryBudgetEventsInput.Type;

export class TelemetryError extends Schema.TaggedError<TelemetryError>()("TelemetryError", {
  message: Schema.String,
}) {}

export const TELEMETRY_METHODS = definePluginMethods({
  measures: {
    method: "telemetry.measures",
    gateway: "read",
    input: TelemetryMeasuresInput,
    output: TelemetryMeasuresResult,
    error: TelemetryError,
  },
  budgets: {
    method: "telemetry.budgets",
    gateway: "read",
    input: TelemetryBudgetsInput,
    output: TelemetryBudgetsResult,
    error: TelemetryError,
  },
  budgetsSet: {
    method: "telemetry.budgets.set",
    gateway: "settingsWrite",
    input: TelemetryBudgetsSetInput,
    output: TelemetryBudget,
    error: TelemetryError,
  },
  budgetsRemove: {
    method: "telemetry.budgets.remove",
    gateway: "settingsWrite",
    input: Schema.Struct({ id: Schema.Int }),
    output: Schema.Struct({}),
    error: TelemetryError,
  },
  budgetEvents: {
    method: "telemetry.budgetEvents",
    gateway: "read",
    input: TelemetryBudgetEventsInput,
    output: Schema.Array(TelemetryBudgetEvent),
    error: TelemetryError,
  },
});

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
});
export type TelemetryMeasure = typeof TelemetryMeasure.Type;

/** Every measure, in a fixed order. */
export const TelemetryMeasuresResult = Schema.Array(TelemetryMeasure);
export type TelemetryMeasuresResult = typeof TelemetryMeasuresResult.Type;

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

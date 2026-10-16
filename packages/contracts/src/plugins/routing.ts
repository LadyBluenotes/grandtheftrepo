import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { definePluginMethods } from "./method.ts";
import { TelemetryMeasure } from "./telemetry.ts";
import { RoutingTier } from "./tier.ts";

export { ROUTING_TIERS, RoutingTier } from "./tier.ts";

/** A provider instance and one of its models, the model id as the catalog lists it. */
export const RoutingEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type RoutingEntry = typeof RoutingEntry.Type;

/** Where a resolved entry came from. */
export const RoutingSource = Schema.Literals(["project", "environment", "builtin"]);
export type RoutingSource = typeof RoutingSource.Type;

/** `environment`, or the id of the project the entry belongs to. */
export const RoutingScope = Schema.Union([Schema.Literal("environment"), ProjectId]);
export type RoutingScope = typeof RoutingScope.Type;

export const RoutingTierState = Schema.Struct({
  /** Null with `source` when no provider instance lists a model, so nothing can be picked. */
  resolved: Schema.NullOr(RoutingEntry),
  source: Schema.NullOr(RoutingSource),
  /** Whether the catalog still offers `resolved`. A saved entry stays saved when it does not. */
  available: Schema.Boolean,
  environment: Schema.NullOr(RoutingEntry),
  /** Always null without a project. */
  project: Schema.NullOr(RoutingEntry),
});
export type RoutingTierState = typeof RoutingTierState.Type;

export const RoutingTiers = Schema.Struct({
  cheap: RoutingTierState,
  standard: RoutingTierState,
  strong: RoutingTierState,
});
export type RoutingTiers = typeof RoutingTiers.Type;

export const RoutingTiersGetInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type RoutingTiersGetInput = typeof RoutingTiersGetInput.Type;

export const RoutingTiersSetInput = Schema.Struct({
  scope: RoutingScope,
  tier: RoutingTier,
  /** Null deletes the saved entry, so the tier falls back to the next source. */
  entry: Schema.NullOr(RoutingEntry),
});
export type RoutingTiersSetInput = typeof RoutingTiersSetInput.Type;

/** The kind of work a launch does, named by the caller. It picks the tier the work starts on. */
export const RoutingTaskClass = Schema.Literals([
  "mechanical",
  "implementation",
  "planning",
  "design",
  "risky_review",
]);
export type RoutingTaskClass = typeof RoutingTaskClass.Type;

/**
 * Why a launch got its tier: a person set it (`manual`), earlier launches of the same work failed
 * (`escalation`), or the task class alone (`rule`).
 */
export const RoutingTierReason = Schema.Literals(["manual", "escalation", "rule"]);
export type RoutingTierReason = typeof RoutingTierReason.Type;

/** The `detail` of a `routing_recommended` event, stored as JSON. */
export const RoutingRecommendedDetail = Schema.Struct({
  taskClass: RoutingTaskClass,
  failedRuns: NonNegativeInt,
  reason: RoutingTierReason,
});
export type RoutingRecommendedDetail = typeof RoutingRecommendedDetail.Type;

const RoutingObservedBase = {
  /** The `routing_events` id of the `routing_recommended` row this answers. */
  recommendationId: PositiveInt,
  /** The provider instance and model of the thread's first run. */
  observed: RoutingEntry,
};

/**
 * The `detail` of a `routing_observed` event, stored as JSON. `flag` is one sentence naming the
 * thread, the recommended tier and the observed model, and is set exactly when `matched` is false.
 */
export const RoutingObservedDetail = Schema.Union([
  Schema.Struct({ ...RoutingObservedBase, matched: Schema.Literal(true), flag: Schema.Null }),
  Schema.Struct({ ...RoutingObservedBase, matched: Schema.Literal(false), flag: Schema.String }),
]);
export type RoutingObservedDetail = typeof RoutingObservedDetail.Type;

/** A project's window: `from` inclusive, `to` exclusive, both instants in UTC, by recommendation time. */
export const RoutingAdherenceInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
});
export type RoutingAdherenceInput = typeof RoutingAdherenceInput.Type;

/** A recommendation whose thread ran something else. `at` is when it was recommended. */
export const RoutingMismatch = Schema.Struct({
  threadId: ThreadId,
  tier: RoutingTier,
  recommended: RoutingEntry,
  observed: RoutingEntry,
  at: IsoDateTime,
  flag: Schema.String,
});
export type RoutingMismatch = typeof RoutingMismatch.Type;

/**
 * Whether the recommended model is the one that ran: the share of observed recommendations whose
 * first run matched, and each recommendation that did not. `unavailable` below the minimum sample, or
 * while the plugin has not finished reading the event log or an event failed to replay.
 */
export const RoutingAdherence = Schema.Struct({
  measure: TelemetryMeasure,
  mismatches: Schema.Array(RoutingMismatch),
});
export type RoutingAdherence = typeof RoutingAdherence.Type;

export class RoutingError extends Schema.TaggedError<RoutingError>()("RoutingError", {
  code: Schema.Literals(["inactive", "invalid", "not_found", "io"]),
  message: Schema.String,
}) {}

export const ROUTING_METHODS = definePluginMethods({
  tiersGet: {
    method: "routing.tiers.get",
    gateway: "read",
    input: RoutingTiersGetInput,
    output: RoutingTiers,
    error: RoutingError,
  },
  tiersSet: {
    method: "routing.tiers.set",
    gateway: "settingsWrite",
    input: RoutingTiersSetInput,
    output: RoutingTiers,
    error: RoutingError,
  },
  adherence: {
    method: "routing.adherence",
    gateway: "read",
    input: RoutingAdherenceInput,
    output: RoutingAdherence,
    error: RoutingError,
  },
});

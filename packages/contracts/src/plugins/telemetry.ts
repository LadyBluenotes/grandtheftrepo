import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, NonNegativeInt, ProjectId } from "../baseSchemas.ts";

export const TELEMETRY_WS_METHODS = {
  measures: "telemetry.measures",
} as const;

/** A project's window: `from` inclusive, `to` exclusive, both instants in UTC. */
export const TelemetryMeasuresInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
});
export type TelemetryMeasuresInput = typeof TelemetryMeasuresInput.Type;

/**
 * One measure over a window. `unavailable` is an answer, not an error: `value` is then null and
 * `missingReason` says why. An `ok` value never stands in for missing data.
 */
export const TelemetryMeasure = Schema.Struct({
  measure: Schema.String,
  state: Schema.Literals(["ok", "unavailable"]),
  value: Schema.NullOr(Schema.Finite),
  unit: Schema.Literals(["ratio", "tokens", "seconds", "count", "usd"]),
  direction: Schema.Literals(["lower_is_better", "higher_is_better"]),
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

export class TelemetryError extends Schema.TaggedError<TelemetryError>()("TelemetryError", {
  message: Schema.String,
}) {}

export const TELEMETRY_RPCS = [
  Rpc.make(TELEMETRY_WS_METHODS.measures, {
    payload: TelemetryMeasuresInput,
    success: TelemetryMeasuresResult,
    error: Schema.Union([TelemetryError, EnvironmentAuthorizationError]),
  }),
] as const;

/** Reads: server-side authorization only. */
export const TELEMETRY_RPC_SCOPES = {
  [TELEMETRY_WS_METHODS.measures]: AuthOrchestrationReadScope,
} as const;

export const TELEMETRY_RPC_SUBSYSTEMS = {
  [TELEMETRY_WS_METHODS.measures]: "plugins",
} as const;

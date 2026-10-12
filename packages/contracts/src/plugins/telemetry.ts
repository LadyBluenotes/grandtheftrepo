import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ProjectId } from "../baseSchemas.ts";

export const TELEMETRY_WS_METHODS = {
  measures: "telemetry.measures",
} as const;

/** A project's usage between two instants. */
export const TelemetryMeasuresInput = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
});
export type TelemetryMeasuresInput = typeof TelemetryMeasuresInput.Type;

/** The measures arrive in #1; until then every query says why it has none. */
export const TelemetryMeasuresResult = Schema.Struct({
  state: Schema.Literal("unavailable"),
  missingReason: Schema.String,
});
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

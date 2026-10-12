import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

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

export const TELEMETRY_METHODS = definePluginMethods({
  measures: {
    method: "telemetry.measures",
    gateway: "read",
    input: TelemetryMeasuresInput,
    output: TelemetryMeasuresResult,
    error: TelemetryError,
  },
});

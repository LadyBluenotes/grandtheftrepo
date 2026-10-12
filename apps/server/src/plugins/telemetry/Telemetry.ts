import type {
  TelemetryError,
  TelemetryMeasuresInput,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MeasureService from "./MeasureService.ts";

/**
 * What the plugin answers over RPC and MCP. Both transports read it with
 * `Effect.serviceOption`: it is in the server's context only while the plugin
 * runs, and its absence is how they tell the plugin is off.
 */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    /** Every measure over a project's window, `unavailable` where its inputs are missing. */
    readonly measures: (
      input: TelemetryMeasuresInput,
    ) => Effect.Effect<TelemetryMeasuresResult, TelemetryError>;
  }
>()("t3/plugins/telemetry/Telemetry") {}

export const layer = Layer.effect(
  Telemetry,
  Effect.map(MeasureService.make, (measures) => Telemetry.of({ measures })),
);

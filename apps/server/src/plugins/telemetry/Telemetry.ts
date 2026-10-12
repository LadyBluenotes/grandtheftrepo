import type {
  TelemetryError,
  TelemetryMeasuresInput,
  TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type * as EventSink from "../../orchestration-v2/EventSink.ts";
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

/** `caughtUp` is the drain of the reactor that fills the tables the measures read. */
export const make = (caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>) =>
  Effect.map(MeasureService.make(caughtUp), (measures) => Telemetry.of({ measures }));

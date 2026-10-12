import type { TelemetryMeasuresInput, TelemetryMeasuresResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * What the plugin answers over RPC and MCP. Both transports read it with
 * `Effect.serviceOption`: it is in the server's context only while the plugin
 * runs, and its absence is how they tell the plugin is off.
 */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    readonly measures: (input: TelemetryMeasuresInput) => Effect.Effect<TelemetryMeasuresResult>;
  }
>()("t3/plugins/telemetry/Telemetry") {}

// shortcut: every query is unavailable, until #1 reads telemetry_turn_usage.
export const layer = Layer.succeed(
  Telemetry,
  Telemetry.of({
    measures: () =>
      Effect.succeed({ state: "unavailable", missingReason: "Measures are not built yet (#1)." }),
  }),
);

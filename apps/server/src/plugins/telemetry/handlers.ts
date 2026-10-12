import {
  TELEMETRY_WS_METHODS,
  TelemetryError,
  type TelemetryMeasuresInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Telemetry from "./Telemetry.ts";

/** The RPC group needs every handler even when the plugin is off, so an inactive plugin answers with an error. */
const telemetry = Effect.serviceOption(Telemetry.Telemetry).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => new TelemetryError({ message: 'Plugin "telemetry" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Spread into the WebSocket handlers through `PluginHost.handlers`. */
export const handlers = {
  [TELEMETRY_WS_METHODS.measures]: (input: TelemetryMeasuresInput) =>
    Effect.flatMap(telemetry, (t) => t.measures(input)),
};

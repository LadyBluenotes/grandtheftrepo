import { TELEMETRY_METHODS, TELEMETRY_REPORT_METHODS, TelemetryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as ReportService from "./report/ReportService.ts";
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
const reports = Effect.serviceOption(ReportService.ReportService).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => new TelemetryError({ message: 'Plugin "telemetry" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = {
  ...PluginRpc.defineHandlers(TELEMETRY_METHODS)({
    measures: (input) => Effect.flatMap(telemetry, (t) => t.measures(input)),
  }),
  ...PluginRpc.defineHandlers(TELEMETRY_REPORT_METHODS)({
    report: (input) => Effect.flatMap(reports, (service) => service.report(input)),
  }),
};

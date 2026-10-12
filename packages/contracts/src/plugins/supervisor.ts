import * as Schema from "effect/Schema";
import { IsoDateTime } from "../baseSchemas.ts";
import { definePluginMethods } from "./method.ts";

/** One sweep's outcome within a tick. A failure or timeout keeps the counts at zero. */
export const SupervisorSweepSummary = Schema.Struct({
  plugin: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ok", "failed", "timed_out"]),
  examined: Schema.Int,
  acted: Schema.Int,
  flags: Schema.Int,
  durationMs: Schema.Int,
  error: Schema.NullOr(Schema.String),
});
export type SupervisorSweepSummary = typeof SupervisorSweepSummary.Type;

/** One tick with its sweeps in the order they ran. */
export const SupervisorTickSummary = Schema.Struct({
  id: Schema.Int,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  dryRun: Schema.Boolean,
  sweeps: Schema.Array(SupervisorSweepSummary),
});
export type SupervisorTickSummary = typeof SupervisorTickSummary.Type;

export const SupervisorStatus = Schema.Struct({
  intervalSeconds: Schema.Int,
  dryRun: Schema.Boolean,
  /** Registered sweeps in the order a tick runs them. */
  sweeps: Schema.Array(Schema.Struct({ plugin: Schema.String, name: Schema.String })),
  latest: Schema.NullOr(SupervisorTickSummary),
});
export type SupervisorStatus = typeof SupervisorStatus.Type;

export const SUPERVISOR_METHODS = definePluginMethods({
  status: {
    method: "supervisor.status",
    gateway: "read",
    input: Schema.Struct({}),
    output: SupervisorStatus,
  },
});

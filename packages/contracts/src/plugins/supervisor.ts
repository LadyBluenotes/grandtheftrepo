import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime } from "../baseSchemas.ts";

export const SUPERVISOR_WS_METHODS = {
  status: "supervisor.status",
} as const;

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

export const SUPERVISOR_RPCS = [
  Rpc.make(SUPERVISOR_WS_METHODS.status, {
    payload: Schema.Struct({}),
    success: SupervisorStatus,
    error: EnvironmentAuthorizationError,
  }),
] as const;

/** Reads: server-side authorization only. */
export const SUPERVISOR_RPC_SCOPES = {
  [SUPERVISOR_WS_METHODS.status]: AuthOrchestrationReadScope,
} as const;

export const SUPERVISOR_RPC_SUBSYSTEMS = {
  [SUPERVISOR_WS_METHODS.status]: "plugins",
} as const;

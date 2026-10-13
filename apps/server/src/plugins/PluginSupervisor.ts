import {
  PluginHostError,
  type SupervisorStatus,
  type SupervisorSweepSummary,
  type SupervisorTickSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as HostDatabase from "./HostDatabase.ts";

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 5;
const SWEEP_TIMEOUT = Duration.seconds(30);
const RETENTION = { days: 30 };

/** `supervisor.json` under the state directory, read once at boot. Changes apply on restart. */
const Settings = Schema.Struct({
  intervalSeconds: Schema.optional(Schema.Int),
  dryRun: Schema.optional(Schema.Boolean),
});
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings));

export interface SweepCounts {
  readonly examined: number;
  readonly acted: number;
  readonly flags: number;
}

type Outcome = Pick<SupervisorSweepSummary, "status" | "examined" | "acted" | "flags" | "error">;

interface Registered {
  readonly plugin: string;
  readonly name: string;
  /** The sweep under its time limit. It never fails; an interrupt rethrows. */
  readonly run: (input: { readonly dryRun: boolean }) => Effect.Effect<Outcome>;
}

/**
 * One timer every plugin hangs its sweeps on. A sweep reads data and applies
 * rules, never calls a model, and reports what it examined, acted on and
 * flagged. The host runs them one at a time in registry order and records
 * each tick; a dry run hands every sweep `dryRun: true`, and it must then
 * change nothing.
 */
export class PluginSupervisor extends Context.Service<
  PluginSupervisor,
  {
    /** Called from a plugin's layer. Fails when `plugin/name` is already registered. */
    readonly register: <E>(sweep: {
      readonly plugin: string;
      readonly name: string;
      readonly run: (input: { readonly dryRun: boolean }) => Effect.Effect<SweepCounts, E>;
    }) => Effect.Effect<void, PluginHostError>;
    /** Runs every registered sweep once, now, and records the summary. */
    readonly tick: Effect.Effect<SupervisorTickSummary, SqlError.SqlError>;
    readonly status: Effect.Effect<SupervisorStatus, SqlError.SqlError>;
    /**
     * Ticks one interval after it starts and every interval after that; returns at once when no
     * sweep is registered. `ticker` forks it.
     */
    readonly loop: Effect.Effect<void, SqlError.SqlError>;
  }
>()("t3/plugins/PluginSupervisor") {}

const NO_COUNTS = { examined: 0, acted: 0, flags: 0 };

const settle = <E>(
  exit: Exit.Exit<SweepCounts, E | Cause.TimeoutError>,
): Effect.Effect<Outcome> => {
  if (Exit.isSuccess(exit)) {
    const { examined, acted, flags } = exit.value;
    // A count that is not a whole number can neither be stored nor encoded, and would break `status` until the tick ages out.
    return Effect.succeed(
      [examined, acted, flags].every((count) => Number.isInteger(count) && count >= 0)
        ? { status: "ok", ...exit.value, error: null }
        : {
            status: "failed",
            ...NO_COUNTS,
            error: "Sweep returned a count that is not a whole number.",
          },
    );
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
  const error = Cause.squash(exit.cause);
  return Effect.succeed(
    Cause.isTimeoutError(error)
      ? { status: "timed_out", ...NO_COUNTS, error: null }
      : {
          status: "failed",
          ...NO_COUNTS,
          error: error instanceof Error ? error.message : String(error),
        },
  );
};

/** `order` is the registry's plugin ids; the registry is not imported because plugins import this module. */
const make = (order: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const filePath = path.join(stateDir, "supervisor.json");
    const defaults = { intervalSeconds: DEFAULT_INTERVAL_SECONDS, dryRun: false };
    const { intervalSeconds, dryRun } = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filePath))) return defaults;
      const parsed = yield* decodeSettings(yield* fs.readFileString(filePath));
      const intervalSeconds = parsed.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
      if (intervalSeconds < MIN_INTERVAL_SECONDS)
        yield* Effect.logWarning("supervisor.json intervalSeconds raised to the minimum", {
          filePath,
          intervalSeconds,
          minimum: MIN_INTERVAL_SECONDS,
        });
      return {
        intervalSeconds: Math.max(intervalSeconds, MIN_INTERVAL_SECONDS),
        dryRun: parsed.dryRun ?? false,
      };
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("supervisor.json unreadable, using defaults", { filePath, cause }).pipe(
          Effect.as(defaults),
        ),
      ),
    );

    const sql = yield* HostDatabase.HostDatabase;

    const sweeps = new Map<string, Registered>();
    const rank = (plugin: string) => {
      const index = order.indexOf(plugin);
      return index === -1 ? order.length : index;
    };
    const ordered = () => [...sweeps.values()].sort((a, b) => rank(a.plugin) - rank(b.plugin));

    const register: PluginSupervisor["Service"]["register"] = (sweep) =>
      Effect.suspend(() => {
        const key = `${sweep.plugin}/${sweep.name}`;
        if (sweeps.has(key))
          return Effect.fail(
            new PluginHostError({ message: `Sweep "${key}" is already registered.` }),
          );
        sweeps.set(key, {
          plugin: sweep.plugin,
          name: sweep.name,
          run: (input) =>
            sweep
              .run(input)
              .pipe(Effect.timeout(SWEEP_TIMEOUT), Effect.exit, Effect.flatMap(settle)),
        });
        return Effect.void;
      });

    const tick: PluginSupervisor["Service"]["tick"] = Effect.gen(function* () {
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const summaries: Array<SupervisorSweepSummary> = [];
      for (const sweep of ordered()) {
        const began = yield* Clock.currentTimeMillis;
        const outcome = yield* sweep.run({ dryRun });
        const durationMs = (yield* Clock.currentTimeMillis) - began;
        summaries.push({ plugin: sweep.plugin, name: sweep.name, ...outcome, durationMs });
      }
      const finished = yield* DateTime.now;
      const finishedAt = DateTime.formatIso(finished);
      const cutoff = DateTime.formatIso(DateTime.subtract(finished, RETENTION));
      const id = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM host_supervisor_tick WHERE started_at < ${cutoff}`;
          const rows = yield* sql<{ readonly id: number }>`
            INSERT INTO host_supervisor_tick (started_at, finished_at, dry_run)
            VALUES (${startedAt}, ${finishedAt}, ${dryRun ? 1 : 0})
            RETURNING id
          `;
          const id = rows[0]?.id ?? 0;
          for (const s of summaries) {
            yield* sql`
              INSERT INTO host_supervisor_sweep
                (tick_id, plugin, name, status, examined, acted, flags, duration_ms, error)
              VALUES
                (${id}, ${s.plugin}, ${s.name}, ${s.status}, ${s.examined}, ${s.acted}, ${s.flags}, ${s.durationMs}, ${s.error})
            `;
          }
          return id;
        }),
      );
      return { id, startedAt, finishedAt, dryRun, sweeps: summaries };
    });

    const status: PluginSupervisor["Service"]["status"] = Effect.gen(function* () {
      const [tick] = yield* sql<{
        readonly id: number;
        readonly started_at: string;
        readonly finished_at: string;
        readonly dry_run: number;
      }>`SELECT id, started_at, finished_at, dry_run FROM host_supervisor_tick ORDER BY id DESC LIMIT 1`;
      const rows =
        tick === undefined
          ? []
          : yield* sql<{
              readonly plugin: string;
              readonly name: string;
              readonly status: SupervisorSweepSummary["status"];
              readonly examined: number;
              readonly acted: number;
              readonly flags: number;
              readonly duration_ms: number;
              readonly error: string | null;
            }>`
              SELECT plugin, name, status, examined, acted, flags, duration_ms, error
              FROM host_supervisor_sweep WHERE tick_id = ${tick.id} ORDER BY rowid
            `;
      return {
        intervalSeconds,
        dryRun,
        sweeps: ordered().map(({ plugin, name }) => ({ plugin, name })),
        latest:
          tick === undefined
            ? null
            : {
                id: tick.id,
                startedAt: tick.started_at,
                finishedAt: tick.finished_at,
                dryRun: tick.dry_run === 1,
                sweeps: rows.map(({ duration_ms, ...row }) => ({
                  ...row,
                  durationMs: duration_ms,
                })),
              },
      };
    });

    const interval = Duration.seconds(intervalSeconds);
    const loop: PluginSupervisor["Service"]["loop"] = Effect.gen(function* () {
      if (sweeps.size === 0) return;
      yield* Effect.sleep(interval);
      yield* tick.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("supervisor tick failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(interval)),
      );
    });

    return PluginSupervisor.of({ register, tick, status, loop });
  });

export const layer = (order: ReadonlyArray<string>) => Layer.effect(PluginSupervisor, make(order));

/**
 * Forks the supervisor's `loop`. A sweep's `run` executes in that fiber, so it sees the services
 * of whatever this layer is built over: `PluginHost.layerAll` builds it over every active plugin.
 * Sweeps register while plugin layers build, so the loop's check waits for activation.
 */
export const ticker = Layer.effectDiscard(
  Effect.flatMap(PluginSupervisor, (supervisor) => forkParked(supervisor.loop)),
);

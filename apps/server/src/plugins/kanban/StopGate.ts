import { KanbanError, type KanbanActor, type KanbanStop } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/**
 * The emergency stop, one stored flag. While it is set, a sweep that would start a thread must
 * not; running agents are untouched and a person starting work by hand is never blocked.
 */
export class StopGate extends Context.Service<
  StopGate,
  {
    /** The stop as it stands, or null. */
    readonly get: Effect.Effect<KanbanStop | null, KanbanError>;
    /** Sets the stop. When it is already set nothing changes and the first stop is returned. */
    readonly set: (input: {
      readonly setBy: KanbanActor;
      readonly reason?: string | undefined;
    }) => Effect.Effect<KanbanStop, KanbanError>;
    /** Clears the stop; succeeds when it was not set. */
    readonly clear: Effect.Effect<void, KanbanError>;
    /**
     * What any sweep that starts a thread calls first. It fails with a `gated` error while the
     * stop is set, and the caller keeps its pending launch for the next tick.
     */
    readonly assertLaunchAllowed: Effect.Effect<void, KanbanError>;
  }
>()("t3/plugins/kanban/StopGate") {}

interface StopRow {
  readonly set_at: string;
  readonly set_by: string;
  readonly reason: string | null;
}

const toStop = (row: StopRow): KanbanStop => ({
  setAt: row.set_at,
  setBy: row.set_by,
  reason: row.reason,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const io = (cause: SqlError.SqlError) =>
    Effect.logWarning("kanban: stop database operation failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new KanbanError({
            code: "io",
            message: "The kanban database could not be read or written.",
          }),
        ),
      ),
    );

  const read = sql<StopRow>`SELECT set_at, set_by, reason FROM stop WHERE id = 1`.pipe(
    Effect.map((rows) => (rows[0] === undefined ? null : toStop(rows[0]))),
  );

  const get: StopGate["Service"]["get"] = read.pipe(Effect.catchTags({ SqlError: io }));

  const set: StopGate["Service"]["set"] = ({ setBy, reason }) =>
    Effect.gen(function* () {
      const setAt = DateTime.formatIso(yield* DateTime.now);
      const trimmed = reason?.trim();
      yield* sql`
        INSERT INTO stop (id, set_at, set_by, reason)
        VALUES (1, ${setAt}, ${setBy}, ${trimmed === undefined || trimmed === "" ? null : trimmed})
        ON CONFLICT (id) DO NOTHING
      `;
      // The row exists now, written by this call or by the one that set it first.
      return (yield* read) ?? (yield* Effect.die("The stop row vanished after it was written."));
    }).pipe(Effect.catchTags({ SqlError: io }));

  const clear: StopGate["Service"]["clear"] = sql`DELETE FROM stop`.pipe(
    Effect.asVoid,
    Effect.catchTags({ SqlError: io }),
  );

  const assertLaunchAllowed: StopGate["Service"]["assertLaunchAllowed"] = Effect.flatMap(
    get,
    (stop) =>
      stop === null
        ? Effect.void
        : Effect.fail(
            new KanbanError({
              code: "gated",
              message: "Emergency stop is set. Clear it to launch tickets.",
            }),
          ),
  );

  return StopGate.of({ get, set, clear, assertLaunchAllowed });
});

/** Over the plugin's `SqlClient`, which the host binds to `plugins/kanban.sqlite`. */
export const layer = Layer.effect(StopGate, make);

import type { OrchestrationV2DomainEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { forkParked } from "../serverActivation.ts";

type EventType = OrchestrationV2DomainEvent["type"];

/** The union member whose `type` includes `T`; some members group several types, which `Extract` misses. */
type EventOf<E, T> = E extends { readonly type: infer U } ? (T extends U ? E : never) : never;

type StoredEventOf<T extends EventType> = Omit<OrchestrationV2StoredEvent, "event"> & {
  readonly event: EventOf<OrchestrationV2DomainEvent, T> & { readonly type: T };
};

/** One handler per event type a plugin cares about. Each runs with the plugin's own `SqlClient`. */
export type Handlers<E = never> = {
  readonly [T in EventType]?: (
    stored: StoredEventOf<T>,
  ) => Effect.Effect<void, E, SqlClient.SqlClient>;
};

/** Attempts after which a failed event stays in the failure table for a person to look at. */
const MAX_ATTEMPTS = 5;
/** The cursor is saved at every multiple of this even when no handler ran, bounding replay after a restart. */
const CURSOR_SAVE_INTERVAL = 256;
const RESUBSCRIBE_DELAY = Duration.minutes(1);

/**
 * Watches committed orchestration events for one plugin and keeps a durable
 * cursor in the plugin's own database, so a restart replays only what the
 * plugin missed. Handlers run one at a time in sequence order, each inside a
 * transaction together with the cursor update; a failing handler rolls back,
 * is recorded, and does not stop later events. Handlers must still be
 * idempotent by `event.id`: a crash after an outside effect redelivers.
 *
 * Call from a plugin's layer. The worker starts after server activation.
 */
export const start = Effect.fn("PluginReactor.start")(function* <E = never>(options: {
  readonly plugin: string;
  /** Where a brand-new cursor begins: at the first event ever, or at the newest one now. */
  readonly from: "start" | "now";
  readonly handlers: Handlers<E>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  // The handlers map is typed per event; dispatch by name hands each stored event to its own entry.
  const handlerFor = (type: EventType) =>
    options.handlers[type] as
      | ((stored: OrchestrationV2StoredEvent) => Effect.Effect<void, E, SqlClient.SqlClient>)
      | undefined;
  const log = (message: string) => `plugin reactor ${options.plugin}: ${message}`;

  yield* sql`CREATE TABLE IF NOT EXISTS host_reactor_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS host_reactor_failure (
    sequence INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    last_error TEXT NOT NULL,
    failed_at TEXT NOT NULL
  )`;

  const saveCursor = (sequence: number) =>
    sql`INSERT INTO host_reactor_cursor (id, sequence) VALUES (1, ${sequence})
        ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence`;

  const readCursor = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly sequence: number;
    }>`SELECT sequence FROM host_reactor_cursor WHERE id = 1`;
    const latest = yield* sink.latestSequence();
    const saved = rows[0]?.sequence;
    if (saved === undefined) {
      const initial = options.from === "now" ? latest : 0;
      yield* saveCursor(initial);
      return initial;
    }
    if (saved > latest) {
      yield* Effect.logWarning(log("cursor is past the event log; clamping"), { saved, latest });
      yield* saveCursor(latest);
      return latest;
    }
    return saved;
  });

  const describe = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return error instanceof Error ? error.message : String(error);
  };

  // `processed` is the highest sequence the worker has finished; `drain` waits on it.
  let processed = 0;
  const waiters = new Set<{ readonly target: number; readonly done: Deferred.Deferred<void> }>();
  const advance = (sequence: number) =>
    Effect.gen(function* () {
      processed = Math.max(processed, sequence);
      for (const waiter of waiters) {
        if (waiter.target <= processed) {
          waiters.delete(waiter);
          yield* Deferred.succeed(waiter.done, undefined);
        }
      }
    });

  const handle = (stored: OrchestrationV2StoredEvent) =>
    Effect.gen(function* () {
      const handler = handlerFor(stored.event.type);
      if (handler === undefined) {
        if (stored.sequence % CURSOR_SAVE_INTERVAL === 0) yield* saveCursor(stored.sequence);
        return yield* advance(stored.sequence);
      }
      const outcome = yield* sql
        .withTransaction(handler(stored).pipe(Effect.andThen(saveCursor(stored.sequence))))
        .pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.failCause(outcome.cause);
        const message = describe(outcome.cause);
        const failedAt = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.logWarning(log("handler failed; recorded for retry"), {
          sequence: stored.sequence,
          type: stored.event.type,
          error: message,
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO host_reactor_failure (sequence, type, attempts, last_error, failed_at)
              VALUES (${stored.sequence}, ${stored.event.type}, 1, ${message}, ${failedAt})
              ON CONFLICT (sequence) DO UPDATE SET
                attempts = attempts + 1, last_error = excluded.last_error, failed_at = excluded.failed_at`;
            yield* saveCursor(stored.sequence);
          }),
        );
      }
      yield* advance(stored.sequence);
    });

  const readEvent = (sequence: number) =>
    Stream.runCollect(sink.stream({ afterSequence: sequence - 1 }).pipe(Stream.take(1))).pipe(
      Effect.map((events) => events.find((stored) => stored.sequence === sequence)),
    );

  const retryFailed = Effect.fn("PluginReactor.retryFailed")(function* () {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly attempts: number;
    }>`SELECT sequence, attempts FROM host_reactor_failure WHERE attempts < ${MAX_ATTEMPTS} ORDER BY sequence`;
    const latest = yield* sink.latestSequence();
    for (const row of rows) {
      // Past the log (state restored from an older copy) the stream would wait for live events forever.
      const stored = row.sequence > latest ? undefined : yield* readEvent(row.sequence);
      const handler = stored === undefined ? undefined : handlerFor(stored.event.type);
      if (stored === undefined || handler === undefined) {
        // The log no longer holds it, or nothing handles it any more: there is nothing to retry.
        yield* sql`DELETE FROM host_reactor_failure WHERE sequence = ${row.sequence}`;
        continue;
      }
      const outcome = yield* sql
        .withTransaction(
          handler(stored).pipe(
            Effect.andThen(sql`DELETE FROM host_reactor_failure WHERE sequence = ${row.sequence}`),
          ),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(outcome)) continue;
      if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.failCause(outcome.cause);
      const attempts = row.attempts + 1;
      const message = describe(outcome.cause);
      const failedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE host_reactor_failure
        SET attempts = ${attempts}, last_error = ${message}, failed_at = ${failedAt}
        WHERE sequence = ${row.sequence}`;
      yield* (attempts >= MAX_ATTEMPTS ? Effect.logError : Effect.logWarning)(
        log(attempts >= MAX_ATTEMPTS ? "giving up on an event" : "retry failed"),
        { sequence: row.sequence, type: stored.event.type, attempts, error: message },
      );
    }
  });

  const subscribe = Effect.gen(function* () {
    const cursor = yield* readCursor;
    // Everything up to the cursor was finished by an earlier process; `drain` must not wait for it.
    yield* advance(cursor);
    yield* Stream.runForEach(sink.stream({ afterSequence: cursor }), handle);
  });

  // Replay starts after activation. A dead stream is logged and resubscribed from the saved cursor.
  yield* forkParked(
    retryFailed().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(log("retry at start failed"), { error: describe(cause) }),
      ),
      Effect.andThen(
        Effect.forever(
          subscribe.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning(log("event stream failed; resubscribing"), {
                    error: describe(cause),
                  }),
            ),
            Effect.andThen(Effect.sleep(RESUBSCRIBE_DELAY)),
          ),
        ),
      ),
    ),
  );

  const drain = Effect.gen(function* () {
    const target = yield* sink.latestSequence();
    const waiter = { target, done: yield* Deferred.make<void>() };
    // Registered before the check, so an `advance` landing between the two cannot be missed.
    waiters.add(waiter);
    if (processed >= target) waiters.delete(waiter);
    else {
      // A caller that gives up (a timeout) must not leave its waiter behind for every later tick.
      yield* Deferred.await(waiter.done).pipe(
        Effect.onInterrupt(() => Effect.sync(() => waiters.delete(waiter))),
      );
    }
  });

  return { drain, retryFailed };
});

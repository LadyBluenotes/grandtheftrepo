import { TelemetryError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EventSink from "../../orchestration-v2/EventSink.ts";

/** How long a read waits for the reactor to catch up before answering without its tables. */
const CATCH_UP_WAIT = Duration.seconds(3);

const failWith =
  (message: string) =>
  <E>(cause: E) =>
    Effect.logWarning("telemetry: tables could not be checked", { cause }).pipe(
      Effect.andThen(Effect.fail(new TelemetryError({ message }))),
    );

/**
 * Why the reactor's tables cannot be read yet, or null when they hold every committed event.
 *
 * The tables trail the event log, by all of it while the reactor replays from the first event (as
 * after migration 2), and a value read from half-filled tables is wrong rather than missing; so a
 * read waits for `caughtUp`, the reactor's drain, for up to `CATCH_UP_WAIT`. The reactor also
 * advances past an event whose handler failed, leaving a row in `host_reactor_failure`; a table
 * missing that event reads as complete, so any such row makes the tables unready too, until a
 * retry (`retryFailed`, which the reactor runs at start) clears it. The measures and the report
 * both answer `unavailable` with the reason.
 */
export const readiness = (caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>) =>
  Effect.gen(function* () {
    const inTime = yield* Effect.timeoutOption(caughtUp, CATCH_UP_WAIT).pipe(
      Effect.catch(failWith("The event log could not be read.")),
    );
    if (Option.isNone(inTime)) return "Telemetry is still replaying the event log.";
    const sql = yield* SqlClient.SqlClient;
    const failures = yield* sql<{
      readonly failed: number;
    }>`SELECT COUNT(*) AS failed FROM host_reactor_failure`.pipe(
      Effect.catchTags({ SqlError: failWith("The telemetry database could not be read.") }),
    );
    const failed = failures[0]?.failed ?? 0;
    return failed > 0
      ? `${failed} event(s) failed to replay into telemetry; retry them before reading measures.`
      : null;
  });

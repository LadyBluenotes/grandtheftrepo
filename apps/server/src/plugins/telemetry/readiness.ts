import { TelemetryError, type ScheduledTask } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import type * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Readiness from "../Readiness.ts";
import { rateSnapshot } from "./rates.ts";
import { taskIdOf } from "./report/WeeklyReportSeed.ts";

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
 * after migrations 2 and 3), and a value read from half-filled tables is wrong rather than missing; so a
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

const RATES: Readiness.Check = { id: "rates", label: "Rate snapshot", target: "usage" };
const WEEKLY_REPORT: Readiness.Check = {
  id: "weekly_report",
  label: "Weekly report task",
  target: "scheduled_tasks",
};
const REACTOR: Readiness.Check = { id: "reactor", label: "Reactor caught up", target: null };

/** Cost measures price turns with the snapshot the Usage page saves; without one, nothing prices. */
export const ratesCheck = (snapshot: "missing" | "unreadable" | number) =>
  snapshot === "missing"
    ? Readiness.attention(
        RATES,
        "No rate snapshot is saved, so cost measures answer unavailable; open Usage to fetch one.",
      )
    : snapshot === "unreadable"
      ? Readiness.attention(
          RATES,
          "The rate snapshot cannot be read, so cost measures answer unavailable; open Usage to fetch it again.",
        )
      : snapshot === 0
        ? Readiness.attention(
            RATES,
            "The rate snapshot holds no rates, so cost measures answer unavailable; open Usage to fetch it again.",
          )
        : Readiness.ready(RATES, `The rate snapshot prices ${snapshot} models.`);

/** The task the plugin seeds at start for a project with a default model, by its fixed id. */
export const weeklyReportCheck = (task: Pick<ScheduledTask, "enabled"> | undefined) =>
  task === undefined
    ? Readiness.attention(
        WEEKLY_REPORT,
        "This project has no Weekly report task; it is created at the next server start once the project has a default model.",
      )
    : task.enabled
      ? Readiness.ready(WEEKLY_REPORT, "The Weekly report task posts the report every Monday.")
      : Readiness.attention(
          WEEKLY_REPORT,
          "The Weekly report task is disabled; enable it under scheduled tasks.",
        );

/** `readiness`'s answer: null when the tables hold every committed event. */
export const reactorCheck = (unready: string | null) =>
  unready === null
    ? Readiness.ready(REACTOR, "The reactor holds every committed event.")
    : Readiness.attention(REACTOR, unready);

/** Telemetry's readiness. Built with the reactor's drain, which only the plugin's layer has. */
export class TelemetryReadiness extends Context.Service<TelemetryReadiness, Readiness.Checks>()(
  "t3/plugins/telemetry/readiness/TelemetryReadiness",
) {}

export const make = Effect.fn("TelemetryReadiness.make")(function* (
  caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const snapshot = rateSnapshot({ fs, path, stateDir });

  const rates = Effect.gen(function* () {
    if (!(yield* fs.exists(snapshot.filePath))) return ratesCheck("missing");
    return yield* snapshot.read.pipe(
      Effect.map((table) => ratesCheck(table.size)),
      Effect.orElseSucceed(() => ratesCheck("unreadable")),
    );
  }).pipe(Readiness.orAttention(RATES));

  // Read where the call runs, as the seed does, so the plugin's tests need not provide it.
  const weeklyReport = (projectId: Parameters<typeof taskIdOf>[0]) =>
    Effect.gen(function* () {
      const service = yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
      if (Option.isNone(service)) {
        return Readiness.attention(WEEKLY_REPORT, "Scheduled tasks are not available here.");
      }
      const id = taskIdOf(projectId);
      const { tasks } = yield* service.value.list();
      return weeklyReportCheck(tasks.find((task) => task.id === id));
    }).pipe(Readiness.orAttention(WEEKLY_REPORT));

  const reactor = readiness(caughtUp).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.map(reactorCheck),
    Readiness.orAttention(REACTOR),
  );

  return TelemetryReadiness.of({
    checks: (projectId) =>
      Effect.all(
        projectId === null ? [rates, reactor] : [rates, weeklyReport(projectId), reactor],
        { concurrency: "unbounded" },
      ),
  });
});

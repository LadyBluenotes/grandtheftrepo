import type { ProjectId, TelemetryMeasuresResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import * as ItemStore from "../items/ItemStore.ts";
import { compare } from "./compare.ts";
import { thresholdFor } from "./thresholds.ts";

/** Whether a window has a measure to compare; telemetry answers every one `unavailable` when it cannot trust its tables. */
const comparable = (window: TelemetryMeasuresResult) =>
  window.some((measure) => measure.state !== "unavailable");

/**
 * Compares each project's efficiency measures over the last seven whole UTC days with the seven
 * before, once a day, and strengthens the project's `efficiency_regression:<measure>` item for
 * each measure that got worse past its threshold, keyed by measure and window so a window adds
 * evidence once. A measure `thresholds.ts` lists as not compared is skipped. A recovery does nothing. A project's `regression_runs` row is written only after
 * all its measures were compared, so a crash or timeout compares it again on the next tick. A
 * project waits for the next tick too when its measures cannot be read, or when either window is
 * unavailable in every measure, as telemetry answers while it replays the event log or holds a
 * failed event. The measures come from the telemetry plugin, read where the sweep runs: while it
 * is off the sweep does nothing. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* ItemStore.ItemStore;
  const projects = yield* ProjectService.ProjectService;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const telemetry = yield* Effect.serviceOption(Telemetry.Telemetry);
      if (Option.isNone(telemetry)) return { examined: 0, acted: 0, flags: 0 };
      const to = DateTime.startOf(yield* DateTime.now, "day");
      const from = DateTime.subtract(to, { days: 7 });
      const windowFrom = DateTime.formatIso(from);
      const current = { from: windowFrom, to: DateTime.formatIso(to) };
      const previous = {
        from: DateTime.formatIso(DateTime.subtract(from, { days: 7 })),
        to: windowFrom,
      };
      const compared = yield* sql<{ readonly project_id: ProjectId }>`SELECT project_id
        FROM regression_runs WHERE window_from = ${windowFrom}`;
      const done = new Set(compared.map((row) => row.project_id));
      let examined = 0;
      let acted = 0;
      for (const { id: projectId } of yield* projects.listShells()) {
        if (done.has(projectId)) continue;
        const measured = yield* Effect.result(
          Effect.all([
            telemetry.value.measures({ projectId, ...previous }),
            telemetry.value.measures({ projectId, ...current }),
          ]),
        );
        if (Result.isFailure(measured)) {
          yield* Effect.logWarning("learning: efficiency measures could not be read", {
            projectId,
            cause: measured.failure,
          });
          continue;
        }
        const [before, after] = measured.success;
        if (!comparable(before) || !comparable(after)) continue;
        examined += 1;
        const earlier = new Map(before.map((measure) => [measure.measure, measure]));
        const regressions = after.flatMap((measure) => {
          const was = earlier.get(measure.measure);
          const threshold = thresholdFor(measure.measure);
          const summary =
            was === undefined || threshold === null ? null : compare(was, measure, threshold);
          return summary === null ? [] : [{ measure: measure.measure, summary }];
        });
        acted += regressions.length;
        if (dryRun) continue;
        for (const { measure, summary } of regressions) {
          yield* items.strengthen(
            projectId,
            `efficiency_regression:${measure}`,
            `regression:${measure}:${windowFrom}`,
            summary,
          );
        }
        const ranAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO regression_runs (project_id, window_from, ran_at)
          VALUES (${projectId}, ${windowFrom}, ${ranAt})
          ON CONFLICT (window_from, project_id) DO NOTHING`;
      }
      return { examined, acted, flags: 0 };
    });

  return { plugin: "learning", name: "regressions", run };
});

import type { CavemanLearnSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Import from "./import.ts";
import * as Plan from "./Plan.ts";

/** caveman's report files under `CAVEMAN_HOME`: its own, and its autopilot's rescan. */
const REPORTS: ReadonlyArray<{
  readonly source: CavemanLearnSource;
  readonly segments: ReadonlyArray<string>;
}> = [
  { source: "canonical", segments: ["reports", "caveman-learn.json"] },
  {
    source: "autopilot",
    segments: ["runtime", "learn-autopilot", "reports", "caveman-learn.json"],
  },
];

const stamp = (file: Import.ReportFile) => `${file.mtime}:${file.size}`;

/**
 * Sweep `caveman/learn`: imports the newest report caveman wrote. A report file is read only when
 * its mtime or size changed since it was last examined, and its plan is stored only when it was
 * generated after every stored plan. It reads files and never runs a scan. `examined` counts the
 * report files present, `acted` the plan imported (or, in a dry run, the one it would import), and
 * `flags` the files skipped with a warning.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /** Each source's file as last examined, starting from the one its newest stored plan came from. */
  const examined = new Map(
    (yield* Import.storedFiles).map((file) => [file.source, stamp(file)] as const),
  );

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const home =
        environment.CAVEMAN_HOME?.trim() || path.join(yield* HostProcess.HomeDirectory, ".caveman");
      let present = 0;
      let flags = 0;
      const read: Array<Import.ReportFile> = [];
      const plans: Array<{ readonly plan: Plan.Plan; readonly file: Import.ReportFile }> = [];
      for (const report of REPORTS) {
        const filePath = path.join(home, ...report.segments);
        const info = yield* fs.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        present += 1;
        const file: Import.ReportFile = {
          source: report.source,
          mtime: Option.getOrElse(
            Option.map(info.value.mtime, (mtime) => mtime.getTime()),
            () => 0,
          ),
          size: Number(info.value.size),
        };
        if (examined.get(report.source) === stamp(file)) continue;
        read.push(file);
        const text = yield* fs.readFileString(filePath).pipe(Effect.option);
        const parsed = Option.isNone(text)
          ? Result.fail("The report could not be read.")
          : Plan.parse(text.value);
        if (Result.isFailure(parsed)) {
          flags += 1;
          yield* Effect.logWarning("caveman learn: skipped a report", {
            path: filePath,
            reason: parsed.failure,
          });
          continue;
        }
        plans.push({ plan: parsed.success, file });
      }

      const newest = plans.reduce<(typeof plans)[number] | undefined>(
        (best, next) =>
          best === undefined ||
          DateTime.isGreaterThan(next.plan.generated_at, best.plan.generated_at)
            ? next
            : best,
        undefined,
      );
      let acted = 0;
      if (newest !== undefined) {
        if (dryRun) {
          if (yield* Import.isNewer(newest.plan)) {
            acted = 1;
            yield* Effect.logInfo("caveman learn: a dry run would import a report", {
              source: newest.file.source,
            });
          }
        } else if (yield* Import.importPlan(newest.plan, newest.file)) {
          acted = 1;
        }
      }
      // A dry run keeps reporting what it would import, so it remembers nothing either.
      if (!dryRun) for (const file of read) examined.set(file.source, stamp(file));
      return { examined: present, acted, flags };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return { plugin: "caveman", name: "learn", run };
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { openDatabase, reportJson } from "./Plan.testkit.ts";
import * as LearnSweep from "./sweep.ts";

/** The sweep over a fresh database and an empty `CAVEMAN_HOME`, with the warnings it logs. */
const start = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-caveman-home-" });
  const sql = yield* openDatabase;
  const make = LearnSweep.make.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  let sweep = yield* make;
  const warnings: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(...(Array.isArray(message) ? message : [message]));
  });
  const files = {
    canonical: path.join(home, "reports", "caveman-learn.json"),
    autopilot: path.join(home, "runtime", "learn-autopilot", "reports", "caveman-learn.json"),
  };
  return {
    files,
    warnings,
    write: (file: string, text: string) =>
      fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(file, text))),
    /** A new sweep over the same database, as after a server restart. */
    restart: Effect.map(make, (next) => {
      sweep = next;
    }),
    /** Sets a file's mtime, so a rewrite can keep or change it on purpose. */
    touch: (file: string, at: string) => {
      const mtime = DateTime.toDateUtc(DateTime.makeUnsafe(at));
      return fs.utimes(file, mtime, mtime);
    },
    tick: (dryRun = false) =>
      sweep
        .run({ dryRun })
        .pipe(
          Effect.provideService(HostProcess.Environment, { CAVEMAN_HOME: home }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
    plans: sql<{ readonly generated_at: string; readonly source: string }>`
      SELECT generated_at, source FROM caveman_learn_plan ORDER BY id
    `,
    sinks: Effect.map(
      sql<{ readonly n: number }>`SELECT count(*) AS n FROM caveman_learn_sink`,
      (rows) => rows[0]?.n ?? 0,
    ),
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("caveman/learn sweep", () => {
  it.effect("a tick with no report files examines nothing and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start;
        assert.deepStrictEqual(yield* h.tick(), { examined: 0, acted: 0, flags: 0 });
        assert.deepStrictEqual(yield* h.plans, []);
      }),
    ),
  );

  it.effect("imports one report, and does not read it again while its mtime and size hold", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start;
        yield* h.write(h.files.canonical, reportJson("2026-10-01T08:00:00Z"));
        const mtime = "2026-10-01T09:00:00Z";
        yield* h.touch(h.files.canonical, mtime);
        assert.deepStrictEqual(yield* h.tick(), { examined: 1, acted: 1, flags: 0 });
        assert.deepStrictEqual(yield* h.plans, [
          { generated_at: "2026-10-01T08:00:00.000Z", source: "canonical" },
        ]);
        assert.strictEqual(yield* h.sinks, 4);

        // A newer plan of the same size under the same mtime is not read, so not imported, and
        // after a restart the stored mtime and size still say the file is unchanged.
        yield* h.write(h.files.canonical, reportJson("2026-10-09T08:00:00Z"));
        yield* h.touch(h.files.canonical, mtime);
        assert.deepStrictEqual(yield* h.tick(), { examined: 1, acted: 0, flags: 0 });
        yield* h.restart;
        assert.deepStrictEqual(yield* h.tick(), { examined: 1, acted: 0, flags: 0 });
        assert.lengthOf(yield* h.plans, 1);

        yield* h.touch(h.files.canonical, "2026-10-09T09:00:00Z");
        assert.deepStrictEqual(yield* h.tick(), { examined: 1, acted: 1, flags: 0 });
        assert.deepStrictEqual(
          (yield* h.plans).map((plan) => plan.generated_at),
          ["2026-10-01T08:00:00.000Z", "2026-10-09T08:00:00.000Z"],
        );
      }),
    ),
  );

  it.effect("of two reports it imports the newer, and reads neither again unchanged", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start;
        yield* h.write(h.files.canonical, reportJson("2026-10-01T08:00:00Z"));
        yield* h.write(h.files.autopilot, reportJson("2026-10-05T08:00:00Z"));
        assert.deepStrictEqual(yield* h.tick(), { examined: 2, acted: 1, flags: 0 });
        assert.deepStrictEqual(yield* h.plans, [
          { generated_at: "2026-10-05T08:00:00.000Z", source: "autopilot" },
        ]);
        assert.deepStrictEqual(yield* h.tick(), { examined: 2, acted: 0, flags: 0 });
        assert.lengthOf(yield* h.plans, 1);
      }),
    ),
  );

  it.effect("a dry run reports what it would import and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start;
        yield* h.write(h.files.canonical, reportJson("2026-10-01T08:00:00Z"));
        yield* h.write(h.files.autopilot, reportJson("2026-10-05T08:00:00Z"));
        assert.deepStrictEqual(yield* h.tick(true), { examined: 2, acted: 1, flags: 0 });
        assert.deepStrictEqual(yield* h.tick(true), { examined: 2, acted: 1, flags: 0 });
        assert.deepStrictEqual(yield* h.plans, []);
        assert.strictEqual(yield* h.sinks, 0);
      }),
    ),
  );

  it.effect("skips and logs a report with another schema, or a damaged one, once each", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start;
        yield* h.write(h.files.canonical, reportJson("2026-10-01T08:00:00Z", "caveman.learn.v2"));
        yield* h.write(h.files.autopilot, "{ truncated");
        assert.deepStrictEqual(yield* h.tick(), { examined: 2, acted: 0, flags: 2 });
        assert.deepStrictEqual(yield* h.plans, []);
        assert.deepStrictEqual(
          h.warnings.filter((value) => typeof value === "string"),
          ["caveman learn: skipped a report", "caveman learn: skipped a report"],
        );
        const reasons = h.warnings.flatMap((value) =>
          typeof value === "object" && value !== null && "reason" in value
            ? [String(value.reason)]
            : [],
        );
        assert.strictEqual(
          reasons[0],
          'The report\'s schema is "caveman.learn.v2"; only caveman.learn.v1 is read.',
        );
        assert.match(reasons[1] ?? "", /^The report does not decode as caveman\.learn\.v1: /);

        assert.deepStrictEqual(yield* h.tick(), { examined: 2, acted: 0, flags: 0 });
        assert.lengthOf(h.warnings, 4);
      }),
    ),
  );
});

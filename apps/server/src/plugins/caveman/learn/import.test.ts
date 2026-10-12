import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Import from "./import.ts";
import * as Plan from "./Plan.ts";
import { openDatabase, reportJson } from "./Plan.testkit.ts";

const file: Import.ReportFile = { source: "canonical", mtime: 1_760_000_000_000, size: 2048 };

const decoded = (text: string) => {
  const parsed = Plan.parse(text);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure);
  return parsed.success;
};

const count = (sql: SqlClient.SqlClient, table: "caveman_learn_plan" | "caveman_learn_sink") =>
  Effect.map(
    sql.unsafe<{ readonly n: number }>(`SELECT count(*) AS n FROM ${table}`),
    (rows) => rows[0]?.n ?? 0,
  );

describe("caveman learn import", () => {
  it.effect("a fixture plan imports as one plan row and its sinks in rank order", () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase;
      const plan = decoded(reportJson("2026-10-10T08:00:00Z"));
      assert.isTrue(
        yield* Import.importPlan(plan, file).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );

      const latest = yield* Import.latest.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (latest === undefined) return assert.fail("Nothing was imported.");
      assert.deepStrictEqual(
        { ...latest.plan, importedAt: "" },
        {
          generatedAt: "2026-10-10T08:00:00.000Z",
          source: "canonical",
          windowFrom: "2026-09-10T00:00:00Z",
          windowTo: "2026-10-10T00:00:00Z",
          caveScore: 72,
          sessionsScanned: 41,
          caveats: ["Counts come from an offline tokenizer."],
          spend: { window_usd: 12.5, unpriced: [] },
          wrapMeasured: { tokens_saved: 120000 },
          importedAt: "",
        },
      );
      assert.deepStrictEqual(
        latest.sinks.map((sink) => [
          sink.rank,
          sink.sinkId,
          sink.class,
          sink.framing,
          sink.tokensPerTurn,
          sink.tokensObserved,
          sink.tokensPerDayRate,
        ]),
        [
          [1, "claude_md_weight:project", "reducible", "forward_rate", 2400, null, 96000],
          [2, "recurring_context:repaste:ab12cd", "recurring_context", "historical", 0, 18000, 0],
          [3, "procedure_repeat:release", "behavioral", "historical", 0, 9000, 0],
          [4, "config_tax:baseline", "load_bearing", "forward_rate", 8000, null, 320000],
        ],
      );
      assert.deepStrictEqual(latest.sinks[0]?.evidence, {
        path: "/home/user/project/CLAUDE.md",
        lines: [12, 40],
      });
      // A null evidence map is stored as an empty one.
      assert.deepStrictEqual(latest.sinks[2]?.evidence, {});
      const stored = yield* sql<{
        readonly source_mtime: number;
        readonly source_size: number;
      }>`SELECT source_mtime, source_size FROM caveman_learn_plan`;
      assert.deepStrictEqual(stored, [{ source_mtime: file.mtime, source_size: file.size }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("importing the same plan again writes nothing", () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase;
      const plan = decoded(reportJson("2026-10-10T08:00:00Z"));
      assert.isTrue(
        yield* Import.importPlan(plan, file).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      const before = yield* sql`SELECT * FROM caveman_learn_plan`;
      const autopilot = { ...file, source: "autopilot" as const, mtime: file.mtime + 1 };
      assert.isFalse(
        yield* Import.importPlan(plan, autopilot).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM caveman_learn_plan`, before);
      assert.strictEqual(yield* count(sql, "caveman_learn_sink"), 4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("the ninth import deletes the oldest plan and its sinks", () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase;
      for (let day = 1; day <= 9; day += 1) {
        const plan = decoded(reportJson(`2026-10-0${day}T08:00:00Z`));
        assert.isTrue(
          yield* Import.importPlan(plan, file).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        );
        assert.strictEqual(yield* count(sql, "caveman_learn_plan"), Math.min(day, 8));
      }
      const kept = yield* sql<{ readonly generated_at: string }>`
        SELECT generated_at FROM caveman_learn_plan ORDER BY generated_at
      `;
      assert.strictEqual(kept[0]?.generated_at, "2026-10-02T08:00:00.000Z");
      assert.strictEqual(kept.at(-1)?.generated_at, "2026-10-09T08:00:00.000Z");
      assert.strictEqual(yield* count(sql, "caveman_learn_sink"), 8 * 4);
      const orphans = yield* sql`
        SELECT plan_id FROM caveman_learn_sink
        WHERE plan_id NOT IN (SELECT id FROM caveman_learn_plan)
      `;
      assert.deepStrictEqual(orphans, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("findings come in rank order, limited, and never carry evidence", () =>
    Effect.gen(function* () {
      const sql = yield* openDatabase;
      const none = yield* Import.findings(10).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.deepStrictEqual(none, { plan: null, findings: [] });

      yield* Import.importPlan(decoded(reportJson("2026-10-10T08:00:00Z")), file).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const { plan, findings } = yield* Import.findings(2).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      assert.strictEqual(plan?.caveScore, 72);
      assert.deepStrictEqual(
        findings.map((finding) => finding.sinkId),
        ["claude_md_weight:project", "recurring_context:repaste:ab12cd"],
      );
      for (const finding of findings) assert.notProperty(finding, "evidence");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("caveman learn plan decoding", () => {
  it("skips a plan with another schema, naming the value", () => {
    const parsed = Plan.parse(reportJson("2026-10-10T08:00:00Z", "caveman.learn.v2"));
    assert.isTrue(Result.isFailure(parsed));
    if (Result.isFailure(parsed)) {
      assert.strictEqual(
        parsed.failure,
        'The report\'s schema is "caveman.learn.v2"; only caveman.learn.v1 is read.',
      );
    }
  });

  it("skips a damaged report with a warning instead of failing", () => {
    for (const text of ["{ not json", '{"schema":"caveman.learn.v1","sinks":"nope"}']) {
      const parsed = Plan.parse(text);
      assert.isTrue(Result.isFailure(parsed));
      if (Result.isFailure(parsed)) {
        assert.match(parsed.failure, /^The report does not decode as caveman\.learn\.v1: /);
      }
    }
  });
});

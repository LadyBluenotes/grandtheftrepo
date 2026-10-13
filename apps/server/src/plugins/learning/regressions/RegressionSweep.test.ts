import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  TelemetryError,
  type TelemetryMeasure,
  type TelemetryMeasuresInput,
  type TelemetryMeasuresResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PluginDatabase from "../../PluginDatabase.ts";
import * as Telemetry from "../../telemetry/Telemetry.ts";
import * as ItemStore from "../items/ItemStore.ts";
import { migrations } from "../migrations.ts";
import * as RegressionSweep from "./RegressionSweep.ts";

const projectId = ProjectId.make("project:regressions");
const otherProjectId = ProjectId.make("project:other");

/** Midday on 2026-10-12, so the current window is 10-05 to 10-12 and the previous 09-28 to 10-05. */
const NOW = Date.UTC(2026, 9, 12, 15, 30);
const day = (date: string) => `${date}T00:00:00.000Z`;

const shell = (id: ProjectId) => ({
  id,
  title: id,
  workspaceRoot: `/repos/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const measure = (
  name: string,
  value: number | null,
  fields: Partial<TelemetryMeasure> = {},
): TelemetryMeasure => ({
  measure: name,
  state: "ok",
  value,
  unit: "tokens",
  direction: "lower_is_better",
  sampleSize: 12,
  missingReason: null,
  provenance: [],
  ...fields,
});

/**
 * The plugin's item store and the sweep over a fresh database, as the plugin's layer builds them,
 * with `projects` listed, and a fake measure service that answers each window by its `from` and
 * fails for the projects in `failing`.
 */
const setup = (projects: ReadonlyArray<ProjectId> = [projectId]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const { sql } = yield* PluginDatabase.open({
      id: "learning",
      filename: ":memory:",
      migrations,
    });
    const context = yield* Layer.build(
      ItemStore.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed(projects.map(shell)),
            }),
          ),
        ),
      ),
    );
    const sweep = yield* RegressionSweep.sweep.pipe(Effect.provide(context));
    const windows = new Map<string, TelemetryMeasuresResult>();
    const requests: Array<TelemetryMeasuresInput> = [];
    const failing = new Set<ProjectId>();
    const telemetry = Telemetry.Telemetry.of({
      measures: (input) =>
        Effect.suspend(() => {
          requests.push(input);
          return failing.has(input.projectId)
            ? Effect.fail(new TelemetryError({ message: "The telemetry database is locked." }))
            : Effect.succeed(windows.get(input.from) ?? []);
        }),
    });
    const items = Context.get(context, ItemStore.ItemStore);
    return {
      sql,
      windows,
      requests,
      failing,
      /** One tick with telemetry on. */
      sweep: (dryRun = false) =>
        sweep.run({ dryRun }).pipe(Effect.provideService(Telemetry.Telemetry, telemetry)),
      /** One tick with telemetry off. */
      sweepWithoutTelemetry: sweep.run({ dryRun: false }),
      runs: sql<{
        readonly project_id: string;
        readonly window_from: string;
        readonly ran_at: string;
      }>`SELECT project_id, window_from, ran_at FROM regression_runs ORDER BY ran_at, project_id`,
      /** Each of the project's items with its evidence, as `[failure mode, occurrences, state, owner kind, evidence]`. */
      itemsOf: (id: ProjectId) =>
        items.list({ projectId: id }).pipe(
          Effect.flatMap((list) => Effect.forEach(list, (item) => items.get(item.id))),
          Effect.map((details) =>
            details.map(({ item, evidence }) => [
              item.failureMode,
              item.occurrences,
              item.state,
              item.ownerKind,
              evidence.map(({ evidenceKey, summary }) => [evidenceKey, summary]),
            ]),
          ),
        ),
    };
  });

it.effect("a lower-is-better measure up 42% opens one open item with no owner kind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);

      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      // The last seven whole UTC days before today, and the seven before them.
      assert.deepEqual(learning.requests, [
        { projectId, from: day("2026-09-28"), to: day("2026-10-05") },
        { projectId, from: day("2026-10-05"), to: day("2026-10-12") },
      ]);
      assert.deepEqual(yield* learning.itemsOf(projectId), [
        [
          "efficiency_regression:context_efficiency",
          1,
          "open",
          null,
          [
            [
              `regression:context_efficiency:${day("2026-10-05")}`,
              "context_efficiency 1200 → 1700 (+42%)",
            ],
          ],
        ],
      ]);
      assert.deepEqual(yield* learning.runs, [
        {
          project_id: projectId,
          window_from: day("2026-10-05"),
          ran_at: "2026-10-12T15:30:00.000Z",
        },
      ]);
    }),
  ),
);

it.effect("a higher-is-better measure down 42% opens one item", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      const ratio = { unit: "ratio", direction: "higher_is_better" } as const;
      learning.windows.set(day("2026-09-28"), [measure("first_review_acceptance", 0.6, ratio)]);
      learning.windows.set(day("2026-10-05"), [measure("first_review_acceptance", 0.35, ratio)]);

      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(yield* learning.itemsOf(projectId), [
        [
          "efficiency_regression:first_review_acceptance",
          1,
          "open",
          null,
          [
            [
              `regression:first_review_acceptance:${day("2026-10-05")}`,
              "first_review_acceptance 0.60 → 0.35 (-42%)",
            ],
          ],
        ],
      ]);
    }),
  ),
);

it.effect(
  "small moves, improvements, small samples, unavailable and zero previous values open nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const learning = yield* setup();
        const unavailable = { state: "unavailable", missingReason: "Not recorded." } as const;
        learning.windows.set(day("2026-09-28"), [
          measure("up_ten_percent", 1000),
          measure("improved", 1700),
          measure("unchanged", 1200),
          measure("small_sample", 1200, { sampleSize: 3 }),
          measure("unavailable", null, unavailable),
          measure("from_zero", 0),
        ]);
        learning.windows.set(day("2026-10-05"), [
          measure("up_ten_percent", 1100),
          measure("improved", 1200),
          measure("unchanged", 1200),
          measure("small_sample", 1700, { sampleSize: 3 }),
          measure("unavailable", null, unavailable),
          measure("from_zero", 1700),
        ]);

        assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 0, flags: 0 });
        assert.deepEqual(yield* learning.itemsOf(projectId), []);
        // Compared all the same, so not asked again today.
        assert.strictEqual((yield* learning.runs).length, 1);
      }),
    ),
);

it.effect("a second sweep the same day asks nothing; a retry after a crash adds no evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);
      yield* learning.sweep();
      const once = yield* learning.itemsOf(projectId);

      yield* TestClock.adjust("8 hours");
      assert.deepEqual(yield* learning.sweep(), { examined: 0, acted: 0, flags: 0 });
      assert.strictEqual(learning.requests.length, 2);
      assert.strictEqual((yield* learning.runs).length, 1);
      assert.deepEqual(yield* learning.itemsOf(projectId), once);

      // A crash after the evidence and before the row: the window is compared again.
      yield* learning.sql`DELETE FROM regression_runs`;
      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      assert.strictEqual((yield* learning.runs).length, 1);
      assert.deepEqual(yield* learning.itemsOf(projectId), once);
    }),
  ),
);

it.effect("the next day, still worse, adds a second piece of evidence to the same item", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);
      yield* learning.sweep();

      yield* TestClock.adjust("1 day");
      learning.windows.set(day("2026-09-29"), [measure("context_efficiency", 1250)]);
      learning.windows.set(day("2026-10-06"), [measure("context_efficiency", 1800)]);
      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(yield* learning.itemsOf(projectId), [
        [
          "efficiency_regression:context_efficiency",
          2,
          "open",
          null,
          [
            [
              `regression:context_efficiency:${day("2026-10-05")}`,
              "context_efficiency 1200 → 1700 (+42%)",
            ],
            [
              `regression:context_efficiency:${day("2026-10-06")}`,
              "context_efficiency 1250 → 1800 (+44%)",
            ],
          ],
        ],
      ]);
      assert.deepEqual(
        (yield* learning.runs).map((run) => run.window_from),
        [day("2026-10-05"), day("2026-10-06")],
      );

      // Recovered the day after: nothing changes.
      yield* TestClock.adjust("1 day");
      learning.windows.set(day("2026-09-30"), [measure("context_efficiency", 1800)]);
      learning.windows.set(day("2026-10-07"), [measure("context_efficiency", 1200)]);
      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 0, flags: 0 });
      assert.strictEqual((yield* learning.itemsOf(projectId))[0]?.[1], 2);
    }),
  ),
);

it.effect("with telemetry off the sweep does nothing and does not fail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);

      assert.deepEqual(yield* learning.sweepWithoutTelemetry, { examined: 0, acted: 0, flags: 0 });
      assert.deepEqual(yield* learning.runs, []);
      assert.deepEqual(yield* learning.itemsOf(projectId), []);
    }),
  ),
);

it.effect("a dry run counts and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup();
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);

      assert.deepEqual(yield* learning.sweep(true), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(yield* learning.runs, []);
      assert.deepEqual(yield* learning.itemsOf(projectId), []);
    }),
  ),
);

it.effect("a project whose measures cannot be read waits for the next tick; the rest go on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup([otherProjectId, projectId]);
      learning.windows.set(day("2026-09-28"), [measure("context_efficiency", 1200)]);
      learning.windows.set(day("2026-10-05"), [measure("context_efficiency", 1700)]);
      learning.failing.add(otherProjectId);

      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      assert.deepEqual(
        (yield* learning.runs).map((run) => run.project_id),
        [projectId],
      );

      learning.failing.clear();
      assert.deepEqual(yield* learning.sweep(), { examined: 1, acted: 1, flags: 0 });
      assert.strictEqual((yield* learning.itemsOf(otherProjectId)).length, 1);
    }),
  ),
);

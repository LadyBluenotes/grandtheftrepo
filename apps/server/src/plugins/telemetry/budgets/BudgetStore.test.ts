import { assert, it } from "@effect/vitest";
import { ProjectId, type TelemetryBudgetsSetInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PluginDatabase from "../../PluginDatabase.ts";
import { migrations } from "../migrations.ts";
import * as BudgetStore from "./BudgetStore.ts";

const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

/** A new budget, with every field. */
const valid = {
  measure: "context_efficiency",
  tier: "standard",
  threshold: 1200,
  direction: "lower_is_better",
  projectId: projectA,
  minSample: 10,
  enabled: true,
};

/** The store over a fresh telemetry database, which the migration gives its three defaults. */
const fixture = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "telemetry", filename: ":memory:", migrations });
  const store = yield* BudgetStore.BudgetStore.pipe(
    Effect.provide(BudgetStore.layer),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  /** The message `set` refused `input` with. */
  const refusal = (input: TelemetryBudgetsSetInput) =>
    store.set(input).pipe(
      Effect.andThen(Effect.die("expected a refusal")),
      Effect.flip,
      Effect.map((error) => error.message),
    );
  return { store, refusal };
});

it.effect("the three defaults exist after migration, one per tier for every project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* fixture;
      assert.deepEqual(
        yield* store.list({}),
        (
          [
            ["cheap", 800],
            ["standard", 1500],
            ["strong", 3000],
          ] as const
        ).map(([tier, threshold], index) => ({
          id: index + 1,
          measure: "context_efficiency",
          tier,
          threshold,
          direction: "lower_is_better" as const,
          projectId: null,
          minSample: 20,
          enabled: true,
          state: "ok" as const,
          latest: [],
        })),
      );
    }),
  ),
);

it.effect("refuses an unknown measure or tier, or a threshold or sample it cannot judge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, refusal } = yield* fixture;
      assert.strictEqual(
        yield* refusal({ ...valid, measure: "speed" }),
        "Budget is invalid: measure",
      );
      assert.strictEqual(yield* refusal({ ...valid, tier: "premium" }), "Budget is invalid: tier");
      assert.strictEqual(
        yield* refusal({ ...valid, threshold: Number.POSITIVE_INFINITY }),
        "Budget is invalid: threshold",
      );
      assert.strictEqual(
        yield* refusal({ ...valid, threshold: Number.NaN }),
        "Budget is invalid: threshold",
      );
      assert.strictEqual(
        yield* refusal({ ...valid, direction: "sideways" }),
        "Budget is invalid: direction",
      );
      assert.strictEqual(
        yield* refusal({ ...valid, minSample: 2.5 }),
        "Budget is invalid: minSample",
      );
      assert.strictEqual((yield* store.list({})).length, 3);
    }),
  ),
);

it.effect("a patch changes only the fields it names, checked as the merged budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, refusal } = yield* fixture;
      const added = yield* store.set({ ...valid, enabled: false, minSample: 7 });

      const patched = yield* store.set({ id: added.id, threshold: 999 });
      assert.deepEqual(
        [patched.threshold, patched.enabled, patched.minSample, patched.tier],
        [999, false, 7, "standard"],
      );

      assert.strictEqual(yield* refusal({ id: 99, threshold: 1 }), "Budget 99 does not exist.");
      assert.strictEqual(
        yield* refusal({ id: added.id, tier: "premium" }),
        "Budget is invalid: tier",
      );
      assert.strictEqual(
        yield* refusal({ id: added.id, threshold: Number.POSITIVE_INFINITY }),
        "Budget is invalid: threshold",
      );
      // A refused patch leaves the stored budget as it was.
      const stored = (yield* store.list({})).find((budget) => budget.id === added.id);
      assert.deepEqual([stored?.tier, stored?.threshold], ["standard", 999]);
    }),
  ),
);

it.effect("two patches to different fields both stand, in either order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const first = yield* store.set(valid);
      const second = yield* store.set(valid);

      // Two clients each change one field of a budget, as the settings table does.
      yield* store.set({ id: first.id, threshold: 2000 });
      yield* store.set({ id: first.id, enabled: false });
      yield* store.set({ id: second.id, enabled: false });
      yield* store.set({ id: second.id, threshold: 2000 });

      const stored = (yield* store.list({})).filter(
        (budget) => budget.id === first.id || budget.id === second.id,
      );
      assert.deepEqual(
        stored.map((budget) => [budget.threshold, budget.enabled, budget.minSample]),
        [
          [2000, false, 10],
          [2000, false, 10],
        ],
      );
    }),
  ),
);

it.effect("records an event only while the budget keeps the terms it was judged on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* fixture;
      const standard = (yield* store.list({}))[1]!;
      const event = {
        projectId: projectA,
        kind: "breach",
        windowFrom: "2026-10-05T00:00:00.000Z",
        windowTo: "2026-10-12T00:00:00.000Z",
        value: 1900,
        sampleSize: 30,
      } as const;
      const terms = {
        id: standard.id,
        measure: standard.measure,
        tier: standard.tier,
        threshold: standard.threshold,
        direction: standard.direction,
        projectId: standard.projectId,
        minSample: standard.minSample,
        enabled: standard.enabled,
      };
      const count = Effect.map(
        store.events({
          projectId: projectA,
          from: "1970-01-01T00:00:00.000Z",
          to: "2027-01-01T00:00:00.000Z",
        }),
        (events) => events.length,
      );

      yield* store.set({ ...terms, threshold: 2500 });
      assert.isFalse(yield* store.record(standard, event));
      yield* store.set({ ...terms, enabled: false });
      assert.isFalse(yield* store.record(standard, event));
      yield* store.set(terms);
      assert.isTrue(yield* store.record(standard, event));
      assert.strictEqual(yield* count, 1);
      yield* store.remove(standard.id);
      assert.isFalse(yield* store.record(standard, event));
      assert.strictEqual(yield* count, 0);
    }),
  ),
);

it.effect("lists the budgets that judge a project, with that project's newest event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 9, 12));
      const { store } = yield* fixture;
      const own = yield* store.set({ ...valid, projectId: projectB });
      const standard = (yield* store.list({}))[1]!;
      const event = {
        windowFrom: "2026-10-05T00:00:00.000Z",
        windowTo: "2026-10-12T00:00:00.000Z",
        value: 1900,
        sampleSize: 30,
      };
      yield* store.record(standard, { ...event, projectId: projectA, kind: "breach" });
      yield* store.record(standard, { ...event, projectId: projectB, kind: "breach" });
      yield* store.record(standard, {
        ...event,
        projectId: projectB,
        kind: "recovery",
        value: 1400,
      });

      const forA = yield* store.list({ projectId: projectA });
      assert.deepEqual(
        forA.map((budget) => [budget.id, budget.state, budget.latest.map((e) => e.kind)]),
        [
          [1, "ok", []],
          [2, "breach", ["breach"]],
          [3, "ok", []],
        ],
      );
      const forB = yield* store.list({ projectId: projectB });
      assert.deepEqual(
        forB.map((budget) => [budget.id, budget.state, budget.latest.map((e) => e.kind)]),
        [
          [1, "ok", []],
          [2, "ok", ["recovery"]],
          [3, "ok", []],
          [own.id, "ok", []],
        ],
      );
      // Overall, a budget is in breach while any project's newest event is a breach.
      const overall = (yield* store.list({})).find((budget) => budget.id === 2);
      assert.deepEqual(
        [overall?.state, overall?.latest.map((e) => [e.projectId, e.kind])],
        [
          "breach",
          [
            [projectA, "breach"],
            [projectB, "recovery"],
          ],
        ],
      );

      assert.deepEqual(
        (yield* store.events({
          projectId: projectB,
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-13T00:00:00.000Z",
        })).map((e) => [e.kind, e.value, e.occurredAt]),
        [
          ["breach", 1900, "2026-10-12T00:00:00.000Z"],
          ["recovery", 1400, "2026-10-12T00:00:00.000Z"],
        ],
      );
      // `to` is exclusive.
      assert.deepEqual(
        yield* store.events({
          projectId: projectB,
          from: "2026-10-01T00:00:00.000Z",
          to: "2026-10-12T00:00:00.000Z",
        }),
        [],
      );
    }),
  ),
);

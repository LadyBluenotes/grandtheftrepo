import { assert, it } from "@effect/vitest";
import {
  type LearningDeclaredMode,
  type LearningFailureKind,
  type LearningError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Attention from "../Attention.ts";
import { flagKeyedToProject } from "../attentionKeys.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import { migrations } from "./migrations.ts";
import * as UnclassifiedSweep from "./UnclassifiedSweep.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadId = ThreadId.make("thread:learning");

interface FlagRow {
  readonly id: number;
  readonly plugin_id: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly text: string;
  readonly resume_action: string;
  readonly cleared_at: string | null;
}

/**
 * The classify and unclassified sweeps over a fresh learning database and an in-memory host
 * database, as the plugin's layer builds them; a tick runs classify first, as the plugin
 * registers them.
 */
const setup = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "learning", filename: ":memory:", migrations });
  const host = yield* PluginDatabase.open({
    id: "_host",
    filename: ":memory:",
    migrations: HostDatabase.migrations,
  });
  const context = yield* Layer.build(
    Layer.mergeAll(
      ItemStore.layer,
      CorrectionStore.layer,
      Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
    ).pipe(Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql))),
  );
  const classify = yield* ClassifySweep.sweep.pipe(Effect.provide(context));
  const unclassified = yield* UnclassifiedSweep.sweep.pipe(Effect.provide(context));
  const itemStore = Context.get(context, ItemStore.ItemStore);
  let sourceKey = 0;
  return {
    corrections: Context.get(context, CorrectionStore.CorrectionStore),
    /**
     * One classify run that runs `between` each time it stores evidence, after it read its batch
     * and before it marks the rows that follow.
     */
    classifyBetween: (between: Effect.Effect<unknown, LearningError>) =>
      ClassifySweep.sweep.pipe(
        Effect.provide(
          Context.add(context, ItemStore.ItemStore, {
            ...itemStore,
            strengthen: (...args) => itemStore.strengthen(...args).pipe(Effect.tap(() => between)),
          }),
        ),
        Effect.flatMap((sweep) => sweep.run({ dryRun: false })),
      ),
    /** One supervisor tick of both sweeps; answers the unclassified sweep's summary. */
    tick: Effect.gen(function* () {
      yield* classify.run({ dryRun: false });
      return yield* unclassified.run({ dryRun: false });
    }),
    /** A correction as a producer stores it, dated now. */
    correct: (
      projectId: ProjectId,
      failureKind: LearningFailureKind,
      declaredMode?: LearningDeclaredMode,
    ) =>
      CorrectionStore.insert({
        projectId,
        threadId,
        failureKind,
        declaredMode,
        description: "Something went wrong.",
        sourceEventIds: [],
        sourceKey: `source:${++sourceKey}`,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    open: host.sql<FlagRow>`SELECT * FROM attention WHERE cleared_at IS NULL ORDER BY id`,
    /** Rows the host connection has inserted, updated or deleted since it opened. */
    changes: host.sql<{ readonly n: number }>`SELECT total_changes() AS n`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
    ),
    items: sql<{ readonly project_id: string; readonly failure_mode: string }>`
      SELECT project_id, failure_mode FROM learning_items ORDER BY project_id, failure_mode`,
  };
});

it.effect(
  "corrections left without a mode for seven days raise one flag per project with a count; declaring their modes clears it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const learning = yield* setup;
        const first = yield* learning.correct(projectA, "changes_requested");
        const second = yield* learning.correct(projectA, "reopened_after_settlement");
        // A provider failure says nothing about the work, and a declared mode is classified.
        yield* learning.correct(projectA, "provider_turn_failed");
        yield* learning.correct(projectA, "review_verdict", "convention");
        const other = yield* learning.correct(projectB, "manual");

        yield* TestClock.adjust("167 hours");
        assert.deepEqual(yield* learning.tick, { examined: 0, acted: 0, flags: 0 });
        assert.deepEqual(yield* learning.open, []);

        yield* TestClock.adjust("1 hour");
        assert.deepEqual(yield* learning.tick, { examined: 3, acted: 2, flags: 2 });
        const raised = yield* learning.open;
        assert.deepEqual(
          raised.map((flag) => [flag.plugin_id, flag.kind, flag.thread_id, flag.text]),
          [
            [
              "learning",
              "unowned_finding",
              "corrections:project-a",
              "2 corrections have had no failure mode for over 7 days, so they count toward no learning item; declare a mode for each under Learning, Corrections.",
            ],
            [
              "learning",
              "unowned_finding",
              "corrections:project-b",
              "1 correction has had no failure mode for over 7 days, so it counts toward no learning item; declare its mode under Learning, Corrections.",
            ],
          ],
        );
        assert.deepEqual(JSON.parse(raised[0]?.resume_action ?? ""), {
          label: "Open corrections",
          target: "plugin",
          pluginId: "learning",
          tab: "corrections",
        });
        // Keyed to the project, so the board's strip and the weekly report list it, and only there.
        assert.isTrue(flagKeyedToProject(raised[0]?.thread_id ?? "", projectA));
        assert.isFalse(flagKeyedToProject(raised[0]?.thread_id ?? "", projectB));

        // Nothing changed, so the next tick writes nothing.
        const unchanged = yield* learning.changes;
        assert.deepEqual(yield* learning.tick, { examined: 3, acted: 0, flags: 2 });
        assert.strictEqual(yield* learning.changes, unchanged);

        // A declared mode is classified on the next tick, before the count, which drops at once.
        const declared = yield* learning.corrections.declare({
          id: first.id,
          declaredMode: "defect",
        });
        assert.include(declared, { declaredMode: "defect", classifiedAt: null });
        assert.deepEqual(yield* learning.tick, { examined: 2, acted: 1, flags: 2 });
        const [rewritten] = yield* learning.open;
        assert.strictEqual(rewritten?.id, raised[0]?.id);
        assert.include(rewritten?.text ?? "", "1 correction has had no failure mode");

        yield* learning.corrections.declare({ id: second.id, declaredMode: "incomplete" });
        yield* learning.corrections.declare({ id: other.id, declaredMode: "defect" });
        assert.deepEqual(yield* learning.tick, { examined: 0, acted: 2, flags: 0 });
        assert.deepEqual(yield* learning.open, []);
        // Each declared correction became evidence on its project's item for the mode.
        assert.deepEqual(yield* learning.items, [
          { project_id: "project-a", failure_mode: "convention" },
          { project_id: "project-a", failure_mode: "defect" },
          { project_id: "project-a", failure_mode: "incomplete" },
          { project_id: "project-b", failure_mode: "defect" },
        ]);
      }),
    ),
);

it.effect("only corrections the Corrections tab's 90-day window shows are counted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* TestClock.adjust("30 minutes");
      yield* learning.correct(projectA, "manual");
      yield* TestClock.adjust("30 minutes");
      yield* learning.correct(projectB, "changes_requested");
      // Now is 90 days and 15 minutes after the start. The tab's window ends at the next hour,
      // 90 days and one hour in, so it starts one hour in: project B's correction is its first,
      // and project A's, under 90 days old, falls just before it.
      yield* TestClock.adjust(Duration.sum(Duration.days(89), Duration.minutes(23 * 60 + 15)));
      assert.deepEqual(yield* learning.tick, { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        (yield* learning.open).map((flag) => flag.thread_id),
        ["corrections:project-b"],
      );
    }),
  ),
);

it.effect("a mode declared while classify holds the correction is classified on the next run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* learning.correct(projectA, "review_verdict", "convention");
      const bare = yield* learning.correct(projectA, "changes_requested");

      // Classify reads both, stores the first one's evidence, and only then marks the second.
      yield* learning.classifyBetween(
        learning.corrections.declare({ id: bare.id, declaredMode: "defect" }),
      );
      assert.include(yield* learning.corrections.get(bare.id), {
        declaredMode: "defect",
        classifiedAt: null,
      });

      yield* learning.tick;
      assert.include(yield* learning.corrections.get(bare.id), { causeClass: "defect" });
      assert.deepEqual(yield* learning.items, [
        { project_id: "project-a", failure_mode: "convention" },
        { project_id: "project-a", failure_mode: "defect" },
      ]);
    }),
  ),
);

it.effect("refuses a mode for a provider failure or a correction that has one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const failed = yield* learning.correct(projectA, "provider_turn_interrupted");
      const verdict = yield* learning.correct(projectA, "review_verdict", "convention");
      const refusal = (id: number) =>
        learning.corrections.declare({ id, declaredMode: "defect" }).pipe(
          Effect.flip,
          Effect.map((error: LearningError) => `${error.code}: ${error.message}`),
        );

      assert.strictEqual(
        yield* refusal(failed.id),
        `invalid: Correction ${failed.id} is a provider failure, which says nothing about the work, so it takes no mode.`,
      );
      assert.strictEqual(
        yield* refusal(verdict.id),
        `invalid: Correction ${verdict.id} already declares convention.`,
      );
      assert.strictEqual(yield* refusal(999), "not_found: No correction 999.");
    }),
  ),
);

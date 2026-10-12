import { assert, it } from "@effect/vitest";
import {
  type LearningDeclaredMode,
  type LearningFailureKind,
  type LearningItemDetail,
  type LearningOwnerKind,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import { migrations } from "./migrations.ts";
import * as PromoteSweep from "./PromoteSweep.ts";
import * as Promoter from "./Promoter.ts";

const projectId = ProjectId.make("project:learning");
const threadId = ThreadId.make("thread:learning");

/** The plugin's stores and both sweeps over a fresh database, as the plugin's layer builds them. */
const setup = Effect.gen(function* () {
  const { sql } = yield* PluginDatabase.open({ id: "learning", filename: ":memory:", migrations });
  const context = yield* Layer.build(
    Layer.mergeAll(ItemStore.layer, Promoter.layer).pipe(
      Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
    ),
  );
  const classify = yield* ClassifySweep.sweep.pipe(Effect.provide(context));
  const promote = yield* PromoteSweep.sweep.pipe(Effect.provide(context));
  let sourceKey = 0;
  return {
    sql,
    items: Context.get(context, ItemStore.ItemStore),
    promoters: Context.get(context, Promoter.PromoterRegistry),
    classify,
    promote,
    /** One supervisor tick: classify, then promote. */
    tick: Effect.gen(function* () {
      return {
        classify: yield* classify.run({ dryRun: false }),
        promote: yield* promote.run({ dryRun: false }),
      };
    }),
    /** A correction as a producer stores it; a review verdict is how #4 will record one. */
    correction: (
      declaredMode: LearningDeclaredMode | undefined,
      failureKind: LearningFailureKind = "review_verdict",
      description = "Reviewer found a problem.",
    ) =>
      CorrectionStore.insert({
        projectId,
        threadId,
        failureKind,
        declaredMode,
        description,
        sourceEventIds: [],
        sourceKey: `source:${++sourceKey}`,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    promotions: sql<{
      readonly owner_kind: string;
      readonly state: string;
      readonly attempts: number;
      readonly next_attempt_at: string | null;
      readonly last_error: string | null;
    }>`SELECT owner_kind, state, attempts, next_attempt_at, last_error
      FROM learning_promotions ORDER BY id`,
    classified: sql<{
      readonly cause_class: string;
      readonly classification_reason: string | null;
    }>`SELECT cause_class, classification_reason FROM corrections ORDER BY id`,
  };
});

/** A promoter for `ownerKind` that fails while `failing` holds and counts its calls. */
const fakePromoter = (ownerKind: LearningOwnerKind, failing: boolean) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<LearningItemDetail>>([]);
    const promoter: Promoter.Promoter = {
      ownerKind,
      promote: (item) =>
        Ref.update(calls, (all) => [...all, item]).pipe(
          Effect.andThen(
            failing
              ? Effect.fail(new Promoter.PromotionError({ ownerKind, message: "Page is locked." }))
              : Effect.void,
          ),
        ),
    };
    return { promoter, calls };
  });

it.effect(
  "a convention verdict becomes a candidate item for project knowledge and one record",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const learning = yield* setup;
        const first = yield* learning.correction("convention");
        const ticked = yield* learning.tick;
        assert.deepEqual(ticked.classify, { examined: 1, acted: 1, flags: 0 });
        const [item] = yield* learning.items.list({ projectId });
        assert.deepInclude(item, {
          failureMode: "convention",
          occurrences: 1,
          state: "candidate",
          ownerKind: "project_knowledge",
          dispositionBy: "rule",
          reason: "Rule: convention goes to project_knowledge.",
        });
        assert.deepEqual(yield* learning.classified, [
          { cause_class: "convention", classification_reason: "declared mode" },
        ]);
        // No promoter for project knowledge yet: the record waits and no attempt is counted.
        assert.deepEqual(yield* learning.promotions, [
          {
            owner_kind: "project_knowledge",
            state: "pending",
            attempts: 0,
            next_attempt_at: null,
            last_error: null,
          },
        ]);
        assert.deepEqual((yield* learning.tick).promote, { examined: 1, acted: 0, flags: 0 });
        assert.strictEqual((yield* learning.promotions)[0]?.attempts, 0);

        const { promoter, calls } = yield* fakePromoter("project_knowledge", false);
        yield* learning.promoters.register(promoter);
        assert.deepEqual((yield* learning.tick).promote, { examined: 2, acted: 1, flags: 0 });
        const handed = yield* Ref.get(calls);
        assert.deepEqual(
          handed.map((detail) => detail.evidence.map((e) => [e.evidenceKey, e.summary])),
          [[[`correction:${first.id}`, "Reviewer found a problem."]]],
        );
        assert.strictEqual((yield* learning.items.get(item!.id)).item.state, "promoted");
        assert.strictEqual((yield* learning.promotions)[0]?.state, "delivered");

        // The same mode again strengthens the one item; a promoted item is not handed over twice.
        yield* learning.correction("convention");
        yield* learning.tick;
        const detail = yield* learning.items.get(item!.id);
        assert.strictEqual(detail.item.occurrences, 2);
        assert.strictEqual(detail.item.state, "promoted");
        assert.strictEqual(detail.evidence.length, 2);
        assert.strictEqual((yield* learning.items.list({ projectId })).length, 1);
        assert.strictEqual((yield* learning.promotions).length, 1);
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }),
    ),
);

it.effect(
  "each rule routes by mode alone; provider failures and undeclared modes stay unclassified",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const learning = yield* setup;
        const modes = [
          "convention",
          "scope_drift",
          "missing_verification",
          "defect",
          "incomplete",
          "unclear_spec",
        ] as const;
        for (const mode of modes) yield* learning.correction(mode);
        // A declared mode on a provider failure is ignored, and prose naming a mode is never read.
        yield* learning.correction("convention", "provider_turn_failed");
        yield* learning.correction("scope_drift", "provider_turn_interrupted");
        yield* learning.correction(undefined, "changes_requested", "convention: scope_drift");
        yield* learning.correction(undefined, "manual", "missing_verification");
        assert.deepEqual((yield* learning.tick).classify, { examined: 10, acted: 6, flags: 0 });

        const items = yield* learning.items.list({ projectId });
        assert.deepEqual(
          items
            .map((item) => [item.failureMode, item.ownerKind, item.state, item.occurrences])
            .sort(),
          [
            ["convention", "project_knowledge", "candidate", 1],
            ["defect", "local_only", "open", 1],
            ["incomplete", "local_only", "open", 1],
            ["missing_verification", "policy", "candidate", 1],
            ["scope_drift", "policy", "candidate", 1],
            ["unclear_spec", "local_only", "open", 1],
          ],
        );
        assert.deepEqual((yield* learning.classified).slice(6), [
          { cause_class: "unclassified", classification_reason: "provider failure" },
          { cause_class: "unclassified", classification_reason: "provider failure" },
          { cause_class: "unclassified", classification_reason: "no declared mode" },
          { cause_class: "unclassified", classification_reason: "no declared mode" },
        ]);
        // Three candidates, three records; the local-only items have nothing to hand over.
        assert.deepEqual((yield* learning.promotions).map((p) => p.owner_kind).sort(), [
          "policy",
          "policy",
          "project_knowledge",
        ]);
        // Classified corrections are not read again.
        assert.deepEqual((yield* learning.tick).classify, { examined: 0, acted: 0, flags: 0 });

        // A mode with no rule, such as a regression, opens an item with no owner.
        const regression = yield* learning.items.strengthen(
          projectId,
          "efficiency_regression:context_efficiency",
          "regression:context_efficiency:2026-10-05",
          "context_efficiency 1200 → 1700 (+42%)",
        );
        assert.deepInclude(regression, {
          state: "open",
          ownerKind: null,
          dispositionBy: "rule",
          reason: "No rule for this failure mode.",
          occurrences: 1,
        });
        const again = yield* learning.items.strengthen(
          projectId,
          "efficiency_regression:context_efficiency",
          "regression:context_efficiency:2026-10-05",
          "context_efficiency 1200 → 1700 (+42%)",
        );
        assert.strictEqual(again.occurrences, 1);
      }),
    ),
);

it.effect("a failing promoter is retried after six hours and gives up after five attempts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const { promoter, calls } = yield* fakePromoter("policy", true);
      yield* learning.promoters.register(promoter);
      yield* learning.correction("scope_drift");
      const callCount = Effect.map(Ref.get(calls), (all) => all.length);

      assert.deepEqual((yield* learning.tick).promote, { examined: 2, acted: 2, flags: 0 });
      assert.strictEqual(yield* callCount, 1);
      assert.deepEqual(yield* learning.promotions, [
        {
          owner_kind: "policy",
          state: "pending",
          attempts: 1,
          next_attempt_at: "1970-01-01T06:00:00.000Z",
          last_error: "Page is locked.",
        },
      ]);

      yield* TestClock.adjust("5 hours");
      yield* learning.tick;
      assert.strictEqual(yield* callCount, 1);
      yield* TestClock.adjust("1 hour");
      yield* learning.tick;
      assert.strictEqual(yield* callCount, 2);

      for (const attempt of [3, 4]) {
        yield* TestClock.adjust("6 hours");
        assert.strictEqual((yield* learning.tick).promote.flags, 0);
        assert.strictEqual(yield* callCount, attempt);
      }
      yield* TestClock.adjust("6 hours");
      assert.strictEqual((yield* learning.tick).promote.flags, 1);
      assert.strictEqual(yield* callCount, 5);
      assert.deepInclude((yield* learning.promotions)[0], {
        state: "failed",
        attempts: 5,
        next_attempt_at: null,
      });

      yield* TestClock.adjust("6 hours");
      yield* learning.tick;
      yield* TestClock.adjust("6 days");
      yield* learning.tick;
      assert.strictEqual(yield* callCount, 5);
      const [item] = yield* learning.items.list({ projectId });
      assert.strictEqual(item?.state, "candidate");
    }),
  ),
);

it.effect("a person's disposition survives later sweeps; promoted is never set by hand", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* learning.correction("convention");
      yield* learning.tick;
      const [ruled] = yield* learning.items.list({ projectId });

      const refused = yield* Effect.flip(
        learning.items.setDisposition({ id: ruled!.id, state: "promoted" }),
      );
      assert.deepInclude(refused, {
        code: "invalid",
        message: "State promoted is set by promotion",
      });
      assert.strictEqual(
        (yield* Effect.flip(learning.items.setDisposition({ id: 999, state: "closed" }))).code,
        "not_found",
      );

      const moved = yield* learning.items.setDisposition({ id: ruled!.id, ownerKind: "policy" });
      assert.deepInclude(moved, {
        ownerKind: "policy",
        state: "candidate",
        dispositionBy: "person",
        reason: "Set by a person.",
      });
      yield* learning.correction("convention");
      yield* learning.tick;
      const [kept] = yield* learning.items.list({ projectId });
      assert.deepInclude(kept, {
        ownerKind: "policy",
        state: "candidate",
        dispositionBy: "person",
        occurrences: 2,
      });

      // Closed, the item's pending record is not attempted, even with a promoter there.
      const { promoter, calls } = yield* fakePromoter("policy", false);
      yield* learning.promoters.register(promoter);
      const closed = yield* learning.items.setDisposition({ id: ruled!.id, state: "closed" });
      assert.strictEqual(closed.state, "closed");
      yield* learning.correction("convention");
      yield* learning.tick;
      assert.deepInclude((yield* learning.items.list({ projectId }))[0], {
        state: "closed",
        ownerKind: "policy",
        occurrences: 3,
      });
      assert.strictEqual((yield* Ref.get(calls)).length, 0);

      // Reopened, it is a candidate again and its record goes out.
      yield* learning.items.setDisposition({ id: ruled!.id, state: "open" });
      yield* learning.tick;
      assert.strictEqual((yield* Ref.get(calls)).length, 1);
      assert.strictEqual((yield* learning.items.get(ruled!.id)).item.state, "promoted");
      // Local only has nothing to hand over: the item is open.
      const local = yield* learning.items.setDisposition({
        id: ruled!.id,
        ownerKind: "local_only",
      });
      assert.strictEqual(local.state, "open");
      assert.deepEqual(
        (yield* learning.items.list({ projectId, state: "open" })).map((item) => item.id),
        [ruled!.id],
      );
    }),
  ),
);

it.effect("a dry run counts and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* learning.correction("missing_verification");
      assert.deepEqual(yield* learning.classify.run({ dryRun: true }), {
        examined: 1,
        acted: 1,
        flags: 0,
      });
      assert.deepEqual(yield* learning.classified, [
        { cause_class: "unclassified", classification_reason: null },
      ]);
      assert.deepEqual(yield* learning.items.list({ projectId }), []);

      yield* learning.classify.run({ dryRun: false });
      assert.deepEqual(yield* learning.promote.run({ dryRun: true }), {
        examined: 1,
        acted: 1,
        flags: 0,
      });
      assert.deepEqual(yield* learning.promotions, []);

      // With a record waiting and a promoter there, a dry run counts the attempt and makes none.
      yield* learning.promote.run({ dryRun: false });
      const { promoter, calls } = yield* fakePromoter("policy", false);
      yield* learning.promoters.register(promoter);
      assert.deepEqual(yield* learning.promote.run({ dryRun: true }), {
        examined: 2,
        acted: 1,
        flags: 0,
      });
      assert.strictEqual((yield* Ref.get(calls)).length, 0);
      assert.deepInclude((yield* learning.promotions)[0], { state: "pending", attempts: 0 });
    }),
  ),
);

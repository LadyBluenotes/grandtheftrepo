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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
/** An agent reviewing from its own thread. */
const reviewer = "thread:reviewer";

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

/**
 * A promoter for `ownerKind` that records the item and key of each call, as a real one would write
 * them, then answers with `then` for that call, numbered from one.
 */
const fakePromoter = (
  ownerKind: LearningOwnerKind,
  then: (call: number) => Effect.Effect<void, Promoter.PromotionError> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<
      ReadonlyArray<{ readonly item: LearningItemDetail; readonly key: Promoter.PromotionKey }>
    >([]);
    const promoter: Promoter.Promoter = {
      ownerKind,
      promote: (item, key) =>
        Ref.updateAndGet(calls, (all) => [...all, { item, key }]).pipe(
          Effect.flatMap((all) => then(all.length)),
        ),
    };
    return { promoter, calls };
  });

const pageLocked = () =>
  Effect.fail(new Promoter.PromotionError({ ownerKind: "policy", message: "Page is locked." }));

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
            state: "proposed",
            attempts: 0,
            next_attempt_at: null,
            last_error: null,
          },
        ]);
        // A candidate whose record is pending is not read again.
        assert.deepEqual((yield* learning.tick).promote, { examined: 0, acted: 0, flags: 0 });
        assert.strictEqual((yield* learning.promotions)[0]?.attempts, 0);

        const { promoter, calls } = yield* fakePromoter("project_knowledge");
        yield* learning.promoters.register(promoter);
        assert.deepEqual((yield* learning.tick).promote, { examined: 1, acted: 1, flags: 0 });
        const handed = yield* Ref.get(calls);
        assert.deepEqual(
          handed.map(({ item }) => item.evidence.map((e) => [e.evidenceKey, e.summary])),
          [[[`correction:${first.id}`, "Reviewer found a problem."]]],
        );
        const [record] = (yield* learning.items.get(item!.id)).promotions;
        assert.deepEqual(
          handed.map(({ key }) => key),
          [
            {
              promotionId: record!.id,
              itemId: item!.id,
              failureMode: "convention",
              ownerKind: "project_knowledge",
            },
          ],
        );
        // The draft is written and waits for review; the item is not promoted until it is adopted.
        assert.strictEqual((yield* learning.items.get(item!.id)).item.state, "candidate");
        assert.strictEqual((yield* learning.promotions)[0]?.state, "in_review");
        yield* learning.items.reviewPromotion(
          { promotionId: record!.id, verdict: "adopt" },
          "user",
        );
        assert.strictEqual((yield* learning.items.get(item!.id)).item.state, "promoted");

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
        // The security scan declares its own mode.
        yield* learning.correction("security", "security", "secret.token at src/config.ts:2");
        // A declared mode on a provider failure is ignored, and prose naming a mode is never read.
        yield* learning.correction("convention", "provider_turn_failed");
        yield* learning.correction("scope_drift", "provider_turn_interrupted");
        yield* learning.correction(undefined, "changes_requested", "convention: scope_drift");
        yield* learning.correction(undefined, "manual", "missing_verification");
        assert.deepEqual((yield* learning.tick).classify, { examined: 11, acted: 7, flags: 0 });

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
            ["security", "policy", "candidate", 1],
            ["unclear_spec", "local_only", "open", 1],
          ],
        );
        assert.deepEqual((yield* learning.classified).slice(6), [
          { cause_class: "security", classification_reason: "declared mode" },
          { cause_class: "unclassified", classification_reason: "provider failure" },
          { cause_class: "unclassified", classification_reason: "provider failure" },
          { cause_class: "unclassified", classification_reason: "no declared mode" },
          { cause_class: "unclassified", classification_reason: "no declared mode" },
        ]);
        // Four candidates, four records; the local-only items have nothing to hand over.
        assert.deepEqual((yield* learning.promotions).map((p) => p.owner_kind).sort(), [
          "policy",
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

it.effect(
  "a security correction stored before the scan declared its mode is classified once migrated",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const learning = yield* setup;
        yield* learning.correction(undefined, "security", "secret.token at src/config.ts:2");
        yield* learning.tick;
        assert.deepEqual(yield* learning.classified, [
          { cause_class: "unclassified", classification_reason: "no declared mode" },
        ]);
        const [, , declareSecurity] = migrations.find(([id]) => id === 7)!;
        yield* declareSecurity.pipe(Effect.provideService(SqlClient.SqlClient, learning.sql));
        assert.deepEqual((yield* learning.tick).classify, { examined: 1, acted: 1, flags: 0 });
        assert.deepEqual(yield* learning.classified, [
          { cause_class: "security", classification_reason: "declared mode" },
        ]);
        const [item] = yield* learning.items.list({ projectId });
        assert.deepInclude(item, { failureMode: "security", ownerKind: "policy", occurrences: 1 });
      }),
    ),
);

it.effect("a failing promoter is retried after six hours and gives up after five attempts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const { promoter, calls } = yield* fakePromoter("policy", pageLocked);
      yield* learning.promoters.register(promoter);
      yield* learning.correction("scope_drift");
      const callCount = Effect.map(Ref.get(calls), (all) => all.length);

      assert.deepEqual((yield* learning.tick).promote, { examined: 2, acted: 2, flags: 0 });
      assert.strictEqual(yield* callCount, 1);
      assert.deepEqual(yield* learning.promotions, [
        {
          owner_kind: "policy",
          state: "proposed",
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

it.effect("a promoter whose plugin is not running waits without counting an attempt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const running = yield* Ref.make(false);
      const { promoter, calls } = yield* fakePromoter("policy");
      yield* learning.promoters.register({ ...promoter, available: Ref.get(running) });
      yield* learning.correction("scope_drift");

      for (const tick of [1, 2]) {
        const ticked = yield* learning.tick;
        // The first tick opens the record; neither offers it to a promoter that is not there.
        assert.deepEqual(
          ticked.promote,
          tick === 1 ? { examined: 1, acted: 1, flags: 0 } : { examined: 0, acted: 0, flags: 0 },
        );
        assert.deepEqual(yield* learning.promoters.ownerKinds, []);
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
        assert.deepEqual(yield* learning.promotions, [
          {
            owner_kind: "policy",
            state: "proposed",
            attempts: 0,
            next_attempt_at: null,
            last_error: null,
          },
        ]);
      }

      yield* Ref.set(running, true);
      assert.deepEqual(yield* learning.promoters.ownerKinds, ["policy"]);
      assert.deepEqual((yield* learning.tick).promote, { examined: 1, acted: 1, flags: 0 });
      assert.strictEqual((yield* Ref.get(calls)).length, 1);
      assert.strictEqual((yield* learning.promotions)[0]?.state, "in_review");
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
      const { promoter, calls } = yield* fakePromoter("policy");
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

      // Reopened, it is a candidate again and its record goes out for review.
      yield* learning.items.setDisposition({ id: ruled!.id, state: "open" });
      yield* learning.tick;
      assert.strictEqual((yield* Ref.get(calls)).length, 1);
      const record = (yield* learning.items.get(ruled!.id)).promotions.find(
        (promotion) => promotion.ownerKind === "policy",
      );
      // A person picked the owner kind, so a person proposed it and an agent reviews it.
      assert.deepInclude(record, { state: "in_review", proposedBy: "user" });
      yield* learning.items.reviewPromotion(
        { promotionId: record!.id, verdict: "adopt" },
        reviewer,
      );
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
      const { promoter, calls } = yield* fakePromoter("policy");
      yield* learning.promoters.register(promoter);
      assert.deepEqual(yield* learning.promote.run({ dryRun: true }), {
        examined: 1,
        acted: 1,
        flags: 0,
      });
      assert.strictEqual((yield* Ref.get(calls)).length, 0);
      assert.deepInclude((yield* learning.promotions)[0], { state: "proposed", attempts: 0 });
    }),
  ),
);

it.effect("an interrupted handover is offered again with the same key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const wrote = yield* Deferred.make<void>();
      // The first call writes and is interrupted before it returns, as the supervisor's timeout does.
      const { promoter, calls } = yield* fakePromoter("policy", (call) =>
        call === 1
          ? Deferred.succeed(wrote, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      yield* learning.promoters.register(promoter);
      yield* learning.correction("scope_drift");
      yield* learning.classify.run({ dryRun: false });

      const first = yield* Effect.forkChild(learning.promote.run({ dryRun: false }));
      yield* Deferred.await(wrote);
      yield* Fiber.interrupt(first);
      assert.deepInclude((yield* learning.promotions)[0], { state: "proposed", attempts: 0 });

      yield* learning.tick;
      const keys = (yield* Ref.get(calls)).map(({ key }) => key);
      assert.strictEqual(keys.length, 2);
      assert.deepEqual(keys[1], keys[0]);
      const [item] = yield* learning.items.list({ projectId });
      assert.strictEqual(
        keys[0]?.promotionId,
        (yield* learning.items.get(item!.id)).promotions[0]?.id,
      );
      assert.strictEqual(item?.state, "candidate");
      assert.strictEqual((yield* learning.promotions)[0]?.state, "in_review");
    }),
  ),
);

it.effect("a draft goes into review when the promoter returns, not when the tick began", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      // A slow promoter: two hours pass before it hands the item over.
      const { promoter } = yield* fakePromoter("project_knowledge", () =>
        TestClock.adjust("2 hours"),
      );
      yield* learning.promoters.register(promoter);
      yield* learning.correction("convention");
      yield* learning.tick;

      const [item] = yield* learning.items.list({ projectId });
      const detail = yield* learning.items.get(item!.id);
      assert.deepEqual(
        detail.promotions.map(({ state, createdAt, deliveredAt }) => [
          state,
          createdAt,
          deliveredAt,
        ]),
        [["in_review", "1970-01-01T00:00:00.000Z", "1970-01-01T02:00:00.000Z"]],
      );
    }),
  ),
);

it.effect("lists each failure mode's earliest delivery, whatever its item's state now", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const elsewhere = ProjectId.make("project:elsewhere");
      const itemFor = (project: ProjectId, mode: string) =>
        learning.items.strengthen(project, mode, `key:${project}:${mode}`, "Again.");
      const defect = yield* itemFor(projectId, "defect");
      const convention = yield* itemFor(projectId, "convention");
      const incomplete = yield* itemFor(projectId, "incomplete");
      const otherDefect = yield* itemFor(elsewhere, "defect");
      const promotion = (
        item: { readonly id: number; readonly projectId: ProjectId; readonly failureMode: string },
        ownerKind: LearningOwnerKind,
        state: string,
        deliveredAt: string | null,
      ) =>
        learning.sql`INSERT INTO learning_promotions
          (item_id, project_id, failure_mode, owner_kind, state, attempts, delivered_at,
            created_at, updated_at)
          VALUES (${item.id}, ${item.projectId}, ${item.failureMode}, ${ownerKind}, ${state}, 0,
            ${deliveredAt}, '2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z')`;
      // Two delivered promotions of one mode: the earlier one is when it was first handed over,
      // whatever its review made of it.
      yield* promotion(defect, "policy", "adopted", "2026-10-06T00:00:00.000Z");
      yield* promotion(defect, "prompt", "rejected", "2026-10-04T00:00:00.000Z");
      yield* promotion(convention, "prompt", "in_review", "2026-10-05T00:00:00.000Z");
      yield* promotion(incomplete, "prompt", "proposed", null);
      yield* promotion(otherDefect, "prompt", "rolled_back", "2026-10-01T00:00:00.000Z");
      // A person closes the item after the handover; the handover stands.
      yield* learning.items.setDisposition({ id: defect.id, state: "closed" });
      assert.strictEqual((yield* learning.items.get(defect.id)).item.state, "closed");

      assert.deepEqual(yield* learning.items.deliveredAt(projectId), [
        { failureMode: "convention", deliveredAt: "2026-10-05T00:00:00.000Z" },
        { failureMode: "defect", deliveredAt: "2026-10-04T00:00:00.000Z" },
      ]);
      assert.deepEqual(yield* learning.items.deliveredAt(elsewhere), [
        { failureMode: "defect", deliveredAt: "2026-10-01T00:00:00.000Z" },
      ]);
      assert.deepEqual(yield* learning.items.deliveredAt(ProjectId.make("project:none")), []);
    }),
  ),
);

it.effect("a person's disposition is stamped when set, and new evidence does not move it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const opened = yield* learning.items.strengthen(projectId, "defect", "key:1", "Once.");
      assert.isNull(opened.dispositionAt);
      yield* TestClock.adjust("1 hour");
      const decided = yield* learning.items.setDisposition({ id: opened.id, ownerKind: "policy" });
      assert.strictEqual(decided.dispositionAt, "1970-01-01T01:00:00.000Z");
      yield* TestClock.adjust("1 hour");
      const strengthened = yield* learning.items.strengthen(projectId, "defect", "key:2", "Twice.");
      assert.deepInclude(strengthened, {
        occurrences: 2,
        dispositionAt: "1970-01-01T01:00:00.000Z",
        updatedAt: "1970-01-01T02:00:00.000Z",
      });
    }),
  ),
);

it.effect("lists a range's deliveries to the owner kinds asked for, oldest first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const elsewhere = ProjectId.make("project:elsewhere");
      const defect = yield* learning.items.strengthen(projectId, "defect", "key:1", "Again.");
      const other = yield* learning.items.strengthen(elsewhere, "defect", "key:2", "Again.");
      const promotion = (
        item: { readonly id: number; readonly projectId: ProjectId },
        ownerKind: LearningOwnerKind,
        state: string,
        deliveredAt: string | null,
        failureMode = "defect",
      ) =>
        learning.sql`INSERT INTO learning_promotions
          (item_id, project_id, failure_mode, owner_kind, state, attempts, delivered_at,
            created_at, updated_at)
          VALUES (${item.id}, ${item.projectId}, ${failureMode}, ${ownerKind}, ${state}, 0,
            ${deliveredAt}, '2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`;
      yield* promotion(defect, "prompt", "adopted", "2026-10-06T00:00:00.000Z");
      yield* promotion(defect, "project_knowledge", "in_review", "2026-10-05T00:00:00.000Z");
      // Another owner kind, one at the range's end, one not delivered, and another project's.
      yield* promotion(defect, "policy", "adopted", "2026-10-06T00:00:00.000Z");
      yield* promotion(defect, "local_only", "adopted", "2026-10-12T00:00:00.000Z");
      yield* promotion(defect, "local_only", "proposed", null, "convention");
      yield* promotion(other, "prompt", "adopted", "2026-10-06T00:00:00.000Z");

      const delivered = (ownerKinds: ReadonlyArray<LearningOwnerKind>) =>
        learning.items.deliveredIn({
          projectId,
          ownerKinds,
          from: "2026-10-05T00:00:00.000Z",
          to: "2026-10-12T00:00:00.000Z",
        });
      assert.deepEqual(
        (yield* delivered(["project_knowledge", "prompt", "local_only"])).map((p) => [
          p.ownerKind,
          p.deliveredAt,
        ]),
        [
          ["project_knowledge", "2026-10-05T00:00:00.000Z"],
          ["prompt", "2026-10-06T00:00:00.000Z"],
        ],
      );
      assert.deepEqual(yield* delivered([]), []);
    }),
  ),
);

it.effect("an item a person moves during its handover stays a candidate for the new owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* learning.correction("convention");
      yield* learning.tick;
      const [item] = yield* learning.items.list({ projectId });
      const { promoter } = yield* fakePromoter("project_knowledge", () =>
        learning.items
          .setDisposition({ id: item!.id, ownerKind: "policy" })
          .pipe(Effect.orDie, Effect.asVoid),
      );
      yield* learning.promoters.register(promoter);

      yield* learning.tick;
      assert.deepInclude((yield* learning.items.get(item!.id)).item, {
        state: "candidate",
        ownerKind: "policy",
        dispositionBy: "person",
      });
      // The old owner's handover is done; the new owner gets its own record.
      yield* learning.tick;
      assert.deepEqual(
        (yield* learning.promotions).map((p) => [p.owner_kind, p.state]),
        [
          ["project_knowledge", "in_review"],
          ["policy", "proposed"],
        ],
      );
    }),
  ),
);

it.effect("a tick takes at most one batch of candidates and one of due promotions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const total = PromoteSweep.BATCH_SIZE + 1;
      for (let n = 1; n <= total; n += 1) {
        const item = yield* learning.items.strengthen(projectId, `mode:${n}`, `key:${n}`, "Again.");
        yield* learning.items.setDisposition({ id: item.id, ownerKind: "policy" });
      }
      const promote = learning.promote.run({ dryRun: false });
      const batch = { examined: PromoteSweep.BATCH_SIZE, acted: PromoteSweep.BATCH_SIZE, flags: 0 };
      const rest = { examined: 1, acted: 1, flags: 0 };

      assert.deepEqual(yield* promote, batch);
      assert.strictEqual((yield* learning.promotions).length, PromoteSweep.BATCH_SIZE);
      assert.deepEqual(yield* promote, rest);
      assert.strictEqual((yield* learning.promotions).length, total);

      const { promoter, calls } = yield* fakePromoter("policy");
      yield* learning.promoters.register(promoter);
      assert.deepEqual(yield* promote, batch);
      assert.deepEqual(yield* promote, rest);
      assert.deepEqual(yield* promote, { examined: 0, acted: 0, flags: 0 });
      assert.strictEqual((yield* Ref.get(calls)).length, total);
    }),
  ),
);

/** A scope drift item with its policy draft in review, written by a promoter that accepts all. */
const inReview = (learning: Effect.Success<typeof setup>) =>
  Effect.gen(function* () {
    const { promoter } = yield* fakePromoter("policy");
    yield* learning.promoters.register(promoter);
    yield* learning.correction("scope_drift");
    yield* learning.tick;
    const [item] = yield* learning.items.list({ projectId });
    const [promotion] = (yield* learning.items.get(item!.id)).promotions;
    return { item: item!, promotion: promotion! };
  });

it.effect("a promotion is adopted only after a verdict from someone other than its proposer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      yield* learning.correction("convention");
      yield* learning.tick;
      const [item] = yield* learning.items.list({ projectId });
      // A person routes it, so a person proposed the handover.
      yield* learning.items.setDisposition({ id: item!.id, ownerKind: "policy" });
      yield* learning.tick;
      const promotion = (yield* learning.items.get(item!.id)).promotions.find(
        (record) => record.ownerKind === "policy",
      )!;
      assert.deepInclude(promotion, { state: "proposed", proposedBy: "user" });
      const review = (verdict: "adopt" | "reject" | "revise", by: string, note?: string) =>
        learning.items.reviewPromotion(
          { promotionId: promotion.id, verdict, ...(note === undefined ? {} : { note }) },
          by,
        );

      // Nothing to review until the draft is written.
      assert.deepInclude(yield* Effect.flip(review("adopt", reviewer)), {
        code: "invalid",
        message: `Promotion ${promotion.id} is proposed; only one in review takes a verdict.`,
      });
      const { promoter } = yield* fakePromoter("policy");
      yield* learning.promoters.register(promoter);
      yield* learning.tick;

      // The proposer's own verdict is refused, whatever it is.
      for (const verdict of ["adopt", "reject", "revise"] as const) {
        assert.deepInclude(yield* Effect.flip(review(verdict, "user")), {
          code: "invalid",
          message: `A person proposed promotion ${promotion.id}, so someone else reviews it, such as an agent with learning_promotion_review.`,
        });
      }
      assert.deepEqual((yield* learning.items.get(item!.id)).reviews, []);

      // A revision keeps it in review; the note is redacted.
      yield* TestClock.adjust("1 hour");
      const revised = yield* review("revise", reviewer, "Narrow it to tests. TOKEN=abc");
      assert.deepInclude(revised, { state: "in_review", adoptedAt: null });
      assert.strictEqual((yield* learning.items.get(item!.id)).item.state, "candidate");

      // An item closed meanwhile no longer wants it; reopened, it does again.
      yield* learning.items.setDisposition({ id: item!.id, state: "closed" });
      assert.deepInclude(yield* Effect.flip(review("adopt", reviewer)), {
        code: "invalid",
        message: `Promotion ${promotion.id}'s item no longer waits for it; reopen the item with that owner kind to adopt it.`,
      });
      yield* learning.items.setDisposition({ id: item!.id, state: "open" });
      yield* TestClock.adjust("1 hour");
      const adopted = yield* review("adopt", reviewer);
      assert.deepInclude(adopted, { state: "adopted", adoptedAt: "1970-01-01T02:00:00.000Z" });
      const detail = yield* learning.items.get(item!.id);
      assert.strictEqual(detail.item.state, "promoted");
      assert.deepEqual(
        detail.reviews.map(({ verdict, reviewer: by, note, createdAt }) => [
          verdict,
          by,
          note,
          createdAt,
        ]),
        [
          ["revise", reviewer, "Narrow it to tests. TOKEN=[redacted]", "1970-01-01T01:00:00.000Z"],
          ["adopt", reviewer, null, "1970-01-01T02:00:00.000Z"],
        ],
      );
      // Decided: a second verdict is refused.
      assert.deepInclude(yield* Effect.flip(review("reject", "thread:another")), {
        code: "invalid",
        message: `Promotion ${promotion.id} is adopted; only one in review takes a verdict.`,
      });
      assert.strictEqual(
        (yield* Effect.flip(
          learning.items.reviewPromotion({ promotionId: 999, verdict: "adopt" }, reviewer),
        )).code,
        "not_found",
      );
    }),
  ),
);

it.effect("a rule's handover is reviewed by a person, and a rejection reopens the item", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const { item, promotion } = yield* inReview(learning);
      assert.deepInclude(promotion, { state: "in_review", proposedBy: "supervisor" });

      const rejected = yield* learning.items.reviewPromotion(
        { promotionId: promotion.id, verdict: "reject", note: "Too broad." },
        "user",
      );
      assert.strictEqual(rejected.state, "rejected");
      assert.deepInclude((yield* learning.items.get(item.id)).item, {
        state: "open",
        ownerKind: "policy",
        reason: "The policy handover was rejected.",
      });

      // The rules no longer route it, and nothing goes to that owner kind again.
      yield* learning.correction("scope_drift");
      yield* learning.tick;
      assert.deepInclude((yield* learning.items.get(item.id)).item, {
        state: "open",
        occurrences: 2,
      });
      assert.strictEqual(
        (yield* learning.items.setDisposition({ id: item.id, ownerKind: "policy" })).state,
        "open",
      );
      // Another owner kind gets a handover of its own.
      const moved = yield* learning.items.setDisposition({ id: item.id, ownerKind: "prompt" });
      assert.strictEqual(moved.state, "candidate");
      yield* learning.tick;
      assert.deepEqual(
        (yield* learning.items.get(item.id)).promotions.map((p) => [p.ownerKind, p.state]),
        [
          ["policy", "rejected"],
          ["prompt", "proposed"],
        ],
      );
    }),
  ),
);

it.effect("rolling back an adopted promotion reopens its item, even a closed one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const learning = yield* setup;
      const { item, promotion } = yield* inReview(learning);
      const rollBack = learning.items.rollBackPromotion({ promotionId: promotion.id }, reviewer);
      // Only an adopted promotion rolls back.
      assert.deepInclude(yield* Effect.flip(rollBack), {
        code: "invalid",
        message: `Promotion ${promotion.id} is in review; only an adopted one rolls back.`,
      });
      yield* learning.items.reviewPromotion(
        { promotionId: promotion.id, verdict: "adopt" },
        "user",
      );
      yield* learning.items.setDisposition({ id: item.id, state: "closed" });

      yield* TestClock.adjust("1 hour");
      assert.deepInclude(yield* rollBack, {
        state: "rolled_back",
        rolledBackAt: "1970-01-01T01:00:00.000Z",
        rolledBackBy: reviewer,
      });
      assert.deepInclude((yield* learning.items.get(item.id)).item, {
        state: "open",
        ownerKind: "policy",
        reason: "The policy handover was rolled back.",
      });
      assert.strictEqual((yield* Effect.flip(rollBack)).code, "invalid");
      // The rules leave it open for a person to route elsewhere or close.
      yield* learning.correction("scope_drift");
      yield* learning.tick;
      assert.strictEqual((yield* learning.items.get(item.id)).item.state, "open");
    }),
  ),
);

it.effect("migration 8 adopts earlier deliveries at their delivery time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { sql } = yield* PluginDatabase.open({
        id: "learning",
        filename: ":memory:",
        migrations: migrations.filter(([id]) => id < 8),
      });
      const item = (id: number, mode: string, by: string) =>
        sql`INSERT INTO learning_items
          (id, project_id, failure_mode, occurrences, state, owner_kind, disposition_by, reason,
            created_at, updated_at)
          VALUES (${id}, ${projectId}, ${mode}, 1, 'candidate', 'policy', ${by}, 'Seeded.',
            '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* item(1, "scope_drift", "rule");
      yield* item(2, "convention", "person");
      yield* item(3, "security", "rule");
      yield* sql`INSERT INTO learning_promotions
        (id, item_id, project_id, failure_mode, owner_kind, state, attempts, created_at, updated_at)
        VALUES (1, 1, ${projectId}, 'scope_drift', 'policy', 'delivered', 0,
            '2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z'),
          (2, 2, ${projectId}, 'convention', 'policy', 'pending', 2,
            '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
          (3, 3, ${projectId}, 'security', 'policy', 'failed', 5,
            '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`;

      const [, , promotionReview] = migrations.find(([id]) => id === 8)!;
      yield* promotionReview.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.deepEqual(
        yield* sql`SELECT id, state, proposed_by, delivered_at, adopted_at
          FROM learning_promotions ORDER BY id`,
        [
          {
            id: 1,
            state: "adopted",
            proposed_by: "supervisor",
            delivered_at: "2026-10-03T00:00:00.000Z",
            adopted_at: "2026-10-03T00:00:00.000Z",
          },
          { id: 2, state: "proposed", proposed_by: "user", delivered_at: null, adopted_at: null },
          {
            id: 3,
            state: "failed",
            proposed_by: "supervisor",
            delivered_at: null,
            adopted_at: null,
          },
        ],
      );
    }),
  ),
);

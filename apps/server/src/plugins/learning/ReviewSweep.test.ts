import { assert, it } from "@effect/vitest";
import { type LearningDeclaredMode, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Attention from "../Attention.ts";
import * as HostDatabase from "../HostDatabase.ts";
import * as PluginDatabase from "../PluginDatabase.ts";
import * as ClassifySweep from "./ClassifySweep.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import { migrations } from "./migrations.ts";
import * as PromoteSweep from "./PromoteSweep.ts";
import * as Promoter from "./Promoter.ts";
import * as ReviewSweep from "./ReviewSweep.ts";

const projectId = ProjectId.make("project:reviews");

/**
 * The plugin's stores and the classify, promote and reviews sweeps over fresh learning and host
 * databases, with a policy promoter that takes every draft.
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
      Promoter.layer,
      Attention.layer.pipe(Layer.provide(Layer.succeed(HostDatabase.HostDatabase, host.sql))),
    ).pipe(Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql))),
  );
  const promoters = Context.get(context, Promoter.PromoterRegistry);
  yield* promoters.register({ ownerKind: "policy", promote: () => Effect.void });
  const classify = yield* ClassifySweep.sweep.pipe(Effect.provide(context));
  const promote = yield* PromoteSweep.sweep.pipe(Effect.provide(context));
  const reviews = yield* ReviewSweep.sweep.pipe(Effect.provide(context));
  const items = Context.get(context, ItemStore.ItemStore);
  let sourceKey = 0;
  return {
    items,
    /** One correction declaring `mode`, classified and handed over by a tick. */
    correct: (mode: LearningDeclaredMode) =>
      CorrectionStore.insert({
        projectId,
        threadId: ThreadId.make("thread:reviews"),
        failureKind: "review_verdict",
        declaredMode: mode,
        description: "Seeded.",
        sourceEventIds: [],
        sourceKey: `seed:${++sourceKey}`,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    /** Classify and promote, then the reviews sweep, whose count it answers with. */
    tick: (dryRun = false) =>
      Effect.gen(function* () {
        yield* classify.run({ dryRun: false });
        yield* promote.run({ dryRun: false });
        return yield* reviews.run({ dryRun });
      }),
    /** The item for `mode` and its promotion, which the ticks have put in review. */
    inReview: (mode: string) =>
      Effect.gen(function* () {
        const item = (yield* items.list({ projectId })).find((row) => row.failureMode === mode)!;
        const promotion = (yield* items.get(item.id)).promotions.find(
          (record) => record.ownerKind === item.ownerKind,
        )!;
        return { item, promotion };
      }),
    /** Every flag ever raised, open or cleared, oldest first. */
    flags: host.sql<{
      readonly thread_id: string;
      readonly kind: string;
      readonly text: string;
      readonly resume_action: string;
      readonly cleared_at: string | null;
    }>`SELECT thread_id, kind, text, resume_action, cleared_at FROM attention ORDER BY id`,
  };
});

it.effect("a draft in review raises one flag that opens its item, until a verdict decides it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup;
      yield* world.correct("scope_drift");
      assert.deepEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      const { item, promotion } = yield* world.inReview("scope_drift");
      assert.strictEqual(promotion.state, "in_review");
      const key = `promotion:${projectId}:${promotion.id}`;
      assert.deepEqual(yield* world.flags, [
        {
          thread_id: key,
          kind: "promotion_review",
          text: "Scope drift handover to policy waits for review by you or an agent.",
          resume_action: JSON.stringify({
            label: "Review",
            target: "plugin",
            pluginId: "learning",
            tab: "items",
            recordId: String(item.id),
          }),
          cleared_at: null,
        },
      ]);

      // A standing flag with the same text is not written again.
      assert.deepEqual(yield* world.tick(), { examined: 1, acted: 0, flags: 1 });

      // A revision keeps it waiting, and says so.
      yield* world.items.reviewPromotion(
        { promotionId: promotion.id, verdict: "revise" },
        "thread:reviewer",
      );
      assert.deepEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 1 });
      assert.deepEqual(
        (yield* world.flags).map((flag) => [flag.text, flag.cleared_at]),
        [
          [
            "Scope drift handover to policy was sent back for a revision; once revised, it waits for review by you or an agent.",
            null,
          ],
        ],
      );

      yield* world.items.reviewPromotion({ promotionId: promotion.id, verdict: "adopt" }, "user");
      // A dry run counts the clear and leaves the flag open.
      assert.deepEqual(yield* world.tick(true), { examined: 1, acted: 1, flags: 0 });
      assert.isNull((yield* world.flags)[0]?.cleared_at);
      assert.deepEqual(yield* world.tick(), { examined: 1, acted: 1, flags: 0 });
      assert.isNotNull((yield* world.flags)[0]?.cleared_at);
      assert.deepEqual(yield* world.tick(), { examined: 0, acted: 0, flags: 0 });
    }),
  ),
);

it.effect("names an agent as the reviewer of a handover a person proposed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup;
      yield* world.correct("convention");
      yield* world.tick();
      const { item } = yield* world.inReview("convention");
      yield* world.items.setDisposition({ id: item.id, ownerKind: "policy" });
      yield* world.tick();
      assert.deepEqual(
        (yield* world.flags).map((flag) => flag.text),
        ["Convention handover to policy waits for review by an agent, since a person proposed it."],
      );
    }),
  ),
);

it.effect("clears the flag once a person closes the item or moves it elsewhere", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* setup;
      yield* world.correct("scope_drift");
      yield* world.correct("missing_verification");
      assert.deepEqual(yield* world.tick(), { examined: 2, acted: 2, flags: 2 });
      const closed = yield* world.inReview("scope_drift");
      const moved = yield* world.inReview("missing_verification");

      yield* world.items.setDisposition({ id: closed.item.id, state: "closed" });
      yield* world.items.setDisposition({ id: moved.item.id, ownerKind: "local_only" });
      assert.deepEqual(yield* world.tick(), { examined: 2, acted: 2, flags: 0 });
      assert.isTrue((yield* world.flags).every((flag) => flag.cleared_at !== null));
      // The promotions are still in review; nothing waits on them while the items do not.
      assert.strictEqual((yield* world.inReview("scope_drift")).promotion.state, "in_review");
    }),
  ),
);

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ItemStore from "./items/ItemStore.ts";
import * as Promoter from "./Promoter.ts";
import * as PromotionStore from "./PromotionStore.ts";

/** The most candidates, and the most due promotions, one tick takes. */
export const BATCH_SIZE = 100;

/**
 * Hands candidate items to their owner kind. Each candidate gets one pending record for its owner
 * kind; one whose record was already delivered is promoted without a second. Each due pending
 * record for a kind with a promoter then goes to that promoter, earliest due first: success
 * delivers it, a failure waits six hours, and the fifth failure gives up and is flagged. A kind
 * with no promoter waits without counting an attempt. A tick takes at most one batch of each,
 * and the rest wait for the next. A dry run counts, calls no promoter and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* ItemStore.ItemStore;
  const promoters = yield* Promoter.PromoterRegistry;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      let examined = 0;
      let acted = 0;
      let flags = 0;
      for (const candidate of yield* PromotionStore.candidates(BATCH_SIZE)) {
        examined += 1;
        acted += 1;
        if (dryRun) continue;
        yield* candidate.promotion_state === null
          ? PromotionStore.open(candidate, now)
          : PromotionStore.markPromoted(candidate.id, candidate.owner_kind, now);
      }
      const ownerKinds = yield* promoters.ownerKinds;
      const due =
        ownerKinds.length === 0 ? [] : yield* PromotionStore.due(now, ownerKinds, BATCH_SIZE);
      for (const promotion of due) {
        const promoter = yield* promoters.get(promotion.ownerKind);
        if (Option.isNone(promoter)) continue;
        examined += 1;
        acted += 1;
        if (dryRun) continue;
        const key = {
          promotionId: promotion.id,
          itemId: promotion.itemId,
          failureMode: promotion.failureMode,
          ownerKind: promotion.ownerKind,
        };
        // Only the promoter can be interrupted: once it returns, its outcome is written.
        const flagged = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const item = yield* restore(items.get(promotion.itemId));
            const outcome = yield* Effect.result(restore(promoter.value.promote(item, key)));
            if (Result.isSuccess(outcome)) {
              yield* PromotionStore.deliver(promotion, now);
              return false;
            }
            return (
              (yield* PromotionStore.fail(promotion, outcome.failure.message, now)) === "failed"
            );
          }),
        );
        if (flagged) flags += 1;
      }
      return { examined, acted, flags };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return { plugin: "learning", name: "promote", run };
});

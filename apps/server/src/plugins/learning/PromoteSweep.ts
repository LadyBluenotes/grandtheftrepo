import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ItemStore from "./items/ItemStore.ts";
import * as Promoter from "./Promoter.ts";
import * as PromotionStore from "./PromotionStore.ts";

/**
 * Hands candidate items to their owner kind. Each candidate gets one pending record for its owner
 * kind; one whose record was already delivered is promoted without a second. Each due pending
 * record then goes to the promoter registered for its kind: success delivers it, a failure waits
 * six hours, and the fifth failure gives up and is flagged. A kind with no promoter waits without
 * counting an attempt. A dry run counts, calls no promoter and writes nothing.
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
      for (const candidate of yield* PromotionStore.candidates) {
        examined += 1;
        if (candidate.promotion_state === "pending" || candidate.promotion_state === "failed") {
          continue;
        }
        acted += 1;
        if (dryRun) continue;
        yield* candidate.promotion_state === null
          ? PromotionStore.open(candidate, now)
          : PromotionStore.markPromoted(candidate.id, now);
      }
      for (const promotion of yield* PromotionStore.due(now)) {
        const promoter = yield* promoters.get(promotion.ownerKind);
        if (Option.isNone(promoter)) continue;
        examined += 1;
        acted += 1;
        if (dryRun) continue;
        const outcome = yield* Effect.result(
          promoter.value.promote(yield* items.get(promotion.itemId)),
        );
        if (Result.isSuccess(outcome)) {
          yield* PromotionStore.deliver(promotion, now);
        } else if (
          (yield* PromotionStore.fail(promotion, outcome.failure.message, now)) === "failed"
        ) {
          flags += 1;
        }
      }
      return { examined, acted, flags };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return { plugin: "learning", name: "promote", run };
});

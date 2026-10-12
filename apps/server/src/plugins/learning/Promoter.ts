import { LearningError, type LearningItemDetail, LearningOwnerKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A promoter could not hand an item over this time. The message is kept as the record's last error. */
export class PromotionError extends Schema.TaggedError<PromotionError>()("PromotionError", {
  ownerKind: LearningOwnerKind,
  message: Schema.String,
}) {}

/** Hands items to one owner kind, such as writing a project knowledge page. */
export interface Promoter {
  readonly ownerKind: LearningOwnerKind;
  /** A failure is tried again six hours later, five attempts in all. */
  readonly promote: (item: LearningItemDetail) => Effect.Effect<void, PromotionError>;
}

/**
 * The promoter for each owner kind. It starts empty; a promotion for a kind with none waits,
 * without counting an attempt, until one registers.
 */
export class PromoterRegistry extends Context.Service<
  PromoterRegistry,
  {
    /** Fails when that owner kind already has one. */
    readonly register: (promoter: Promoter) => Effect.Effect<void, LearningError>;
    readonly get: (ownerKind: LearningOwnerKind) => Effect.Effect<Option.Option<Promoter>>;
  }
>()("t3/plugins/learning/Promoter/PromoterRegistry") {}

export const layer = Layer.sync(PromoterRegistry, () => {
  const promoters = new Map<LearningOwnerKind, Promoter>();
  return PromoterRegistry.of({
    register: (promoter) =>
      Effect.suspend(() => {
        if (promoters.has(promoter.ownerKind)) {
          return Effect.fail(
            new LearningError({
              code: "invalid",
              message: `A promoter for ${promoter.ownerKind} is already registered.`,
            }),
          );
        }
        promoters.set(promoter.ownerKind, promoter);
        return Effect.void;
      }),
    get: (ownerKind) => Effect.sync(() => Option.fromNullishOr(promoters.get(ownerKind))),
  });
});

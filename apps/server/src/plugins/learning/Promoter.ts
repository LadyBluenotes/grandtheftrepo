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

/** Names one handover. A promotion is offered with the same key on every attempt. */
export interface PromotionKey {
  /** The promotion record's id, durable across restarts. */
  readonly promotionId: number;
  readonly itemId: number;
  readonly failureMode: string;
  readonly ownerKind: LearningOwnerKind;
}

/** Hands items to one owner kind, such as writing a project knowledge page. */
export interface Promoter {
  readonly ownerKind: LearningOwnerKind;
  /**
   * Whether the plugin that takes this owner kind's items is running. A promotion for a kind whose
   * plugin is off waits, without counting an attempt, exactly as one for a kind with no promoter
   * does. Read where the sweep runs, with `Effect.serviceOption`: a sibling plugin's service is
   * not visible while a layer builds. Left out, the kind is always available.
   */
  readonly available?: Effect.Effect<boolean>;
  /**
   * Delivery is at least once. The record is marked delivered only after this returns, so a crash,
   * an interrupt or a failed write after the owner took the item offers the same promotion again
   * with the same key. A promoter must deduplicate on `key.promotionId`, such as by storing it with
   * what it wrote and treating a second call as done. A failure is tried again six hours later,
   * five attempts in all.
   */
  readonly promote: (
    item: LearningItemDetail,
    key: PromotionKey,
  ) => Effect.Effect<void, PromotionError>;
}

/**
 * The promoter for each owner kind. A promotion for a kind with none, or whose promoter is not
 * `available`, waits without counting an attempt until one is.
 */
export class PromoterRegistry extends Context.Service<
  PromoterRegistry,
  {
    /** Fails when that owner kind already has one. */
    readonly register: (promoter: Promoter) => Effect.Effect<void, LearningError>;
    /** The registered promoter, whether or not its plugin is running. */
    readonly get: (ownerKind: LearningOwnerKind) => Effect.Effect<Option.Option<Promoter>>;
    /** The owner kinds that have a promoter whose plugin is running. */
    readonly ownerKinds: Effect.Effect<ReadonlyArray<LearningOwnerKind>>;
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
    ownerKinds: Effect.suspend(() =>
      Effect.filter(
        [...promoters.values()],
        (promoter) => promoter.available ?? Effect.succeed(true),
      ),
    ).pipe(Effect.map((running) => running.map((promoter) => promoter.ownerKind))),
  });
});

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { learnedDraft, modeSlug } from "../learning/learnedDraft.ts";
import * as Promoter from "../learning/Promoter.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

const ownerKind = "project_knowledge";
const KEY_PREFIX = "learned-";
/** The longest a page key is, from `KnowledgeKey`. */
const KEY_MAX_LENGTH = 64;

/**
 * The page key for an item: `learned-<failure-mode>-<itemId>`, with the mode cut short enough for
 * the key to stay valid.
 */
const keyOf = (failureMode: string, itemId: number) => {
  const suffix = `-${itemId}`;
  const room = KEY_MAX_LENGTH - KEY_PREFIX.length - suffix.length;
  return `${KEY_PREFIX}${modeSlug(failureMode).slice(0, room).replace(/-+$/, "")}${suffix}`;
};

const store = Effect.serviceOption(KnowledgeStore.KnowledgeStore);

/**
 * Hands an item to the knowledge plugin as a draft page for a person to accept. The plugin is
 * reached when the sweep runs, so learning needs no dependency on it: with the plugin off the kind
 * is not available and its promotions wait.
 *
 * `proposeForPromotion` saves one page per promotion, atomically, and answers a repeat with the page
 * saved before, whatever became of it since, so a repeat, even one that overlaps or follows a
 * person discarding the draft, writes nothing.
 */
export const promoter = {
  ownerKind,
  available: Effect.map(store, Option.isSome),
  promote: (detail, { promotionId, itemId }) =>
    Effect.gen(function* () {
      const pages = yield* store;
      if (Option.isNone(pages)) {
        return yield* new Promoter.PromotionError({
          ownerKind,
          message: "The knowledge plugin is not running.",
        });
      }
      const { projectId, failureMode } = detail.item;
      yield* pages.value.proposeForPromotion(
        { projectId, key: keyOf(failureMode, itemId), ...learnedDraft(detail) },
        { itemId, promotionId },
      );
    }).pipe(
      Effect.catchTags({
        KnowledgeError: (error) =>
          Effect.fail(new Promoter.PromotionError({ ownerKind, message: error.message })),
      }),
    ),
} satisfies Promoter.Promoter;

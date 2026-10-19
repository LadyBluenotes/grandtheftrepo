import * as Effect from "effect/Effect";

import { learnedDraft } from "../learnedDraft.ts";
import * as Promoter from "../Promoter.ts";
import * as PromptStore from "./PromptStore.ts";

const ownerKind = "prompt";

/**
 * Hands an item to the prompt library as a proposed prompt for a person to accept, titled
 * `Learned: <failure mode>`. The library is the learning plugin's own, so the kind is always
 * available. The promotion's id is the prompt's source key, so a repeat saves nothing.
 */
export const promoter = Effect.map(
  PromptStore.PromptStore,
  (prompts) =>
    ({
      ownerKind,
      promote: (detail, { promotionId }) =>
        prompts
          .proposeFrom({
            projectId: detail.item.projectId,
            kind: "prompt",
            ...learnedDraft(detail),
            origin: "learning",
            sourceKey: `promotion:${promotionId}`,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTags({
              LearningError: (error) =>
                Effect.fail(new Promoter.PromotionError({ ownerKind, message: error.message })),
            }),
          ),
    }) satisfies Promoter.Promoter,
);

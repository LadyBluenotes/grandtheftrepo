import type { LearningOwnerKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { learnedDraft, modeSlug } from "../learning/learnedDraft.ts";
import * as Promoter from "../learning/Promoter.ts";
import * as PolicyService from "./PolicyService.ts";

const service = Effect.serviceOption(PolicyService.PolicyService);

/**
 * Hands an item to the policy plugin as a draft version for a person to accept; the key is
 * `keyPrefix` and `learned-<failure-mode>`, and an accepted version of that key makes the draft
 * the next one. Like the knowledge promoter, the plugin is reached when the sweep runs, so with it
 * off the kind is not available and its promotions wait.
 */
const draftsFor = (ownerKind: LearningOwnerKind, keyPrefix: string) =>
  ({
    ownerKind,
    available: Effect.map(service, Option.isSome),
    promote: (detail, { promotionId }) =>
      Effect.gen(function* () {
        const policies = yield* service;
        if (Option.isNone(policies)) {
          return yield* new Promoter.PromotionError({
            ownerKind,
            message: "The policy plugin is not running.",
          });
        }
        const { projectId, failureMode } = detail.item;
        const draft = learnedDraft(detail);
        yield* policies.value.createForPromotion(
          {
            projectId,
            key: `${keyPrefix}learned-${modeSlug(failureMode)}`,
            title: draft.title,
            // A policy block is delimited by its marker, which the body cannot contain.
            body: draft.body.replaceAll("fork-policy:", "fork-policy "),
          },
          promotionId,
        );
      }).pipe(
        Effect.catchTags({
          PolicyError: (error) =>
            Effect.fail(new Promoter.PromotionError({ ownerKind, message: error.message })),
        }),
      ),
  }) satisfies Promoter.Promoter;

export const policyPromoter = draftsFor("policy", "");

/** Until briefs read prompt policies (#79), a prompt reaches agents as any accepted policy does. */
export const promptPromoter = draftsFor("prompt", "prompt-");

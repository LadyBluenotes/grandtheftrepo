import type { LearningOwnerKind, LearningReviewVerdict, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Attention from "../Attention.ts";

const PLUGIN_ID = "learning";
const KIND = "promotion_review";

/**
 * A flag is per promotion, and carries the project as a segment so the board's strip lists it
 * (`plugins/attentionKeys.ts`).
 */
const flagKey = (projectId: ProjectId, promotionId: number) =>
  `promotion:${projectId}:${promotionId}`;

const spaced = (name: string) => name.replaceAll("_", " ");

/** What the flag says: who can review it, and whether a reviewer asked for a revision. */
const reviewFlagText = (promotion: {
  readonly failureMode: string;
  readonly ownerKind: LearningOwnerKind;
  readonly proposedBy: string;
  readonly lastVerdict: LearningReviewVerdict | null;
}) => {
  const mode = spaced(promotion.failureMode);
  const subject = `${mode.charAt(0).toUpperCase()}${mode.slice(1)} handover to ${spaced(promotion.ownerKind)}`;
  const reviewer =
    promotion.proposedBy === "user" ? "an agent, since a person proposed it" : "you or an agent";
  return promotion.lastVerdict === "revise"
    ? `${subject} was sent back for a revision; once revised, it waits for review by ${reviewer}.`
    : `${subject} waits for review by ${reviewer}.`;
};

/**
 * Keeps one `promotion_review` flag, keyed by project and promotion, for each promotion in review
 * whose item still wants it: a candidate with the same owner kind. Its action opens the item on
 * the Learning screen. A flag whose promotion was decided, or whose item a person closed or moved
 * to another owner kind, is cleared; a standing one is rewritten only when its text changes.
 * `examined` counts the promotions waiting and the stale flags, `acted` the flags raised,
 * rewritten or cleared, `flags` those standing after the tick. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attention = yield* Attention.Attention;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const open = new Map(
        (yield* attention.listOpen({ pluginId: PLUGIN_ID, kind: KIND })).map((flag) => [
          flag.threadId,
          flag.text,
        ]),
      );
      // One per item at most: a record is unique per owner kind, and the item has one.
      const waiting = yield* sql<{
        readonly id: number;
        readonly item_id: number;
        readonly project_id: ProjectId;
        readonly failure_mode: string;
        readonly owner_kind: LearningOwnerKind;
        readonly proposed_by: string;
        readonly last_verdict: LearningReviewVerdict | null;
      }>`SELECT p.id, p.item_id, p.project_id, p.failure_mode, p.owner_kind, p.proposed_by,
          (SELECT r.verdict FROM promotion_reviews r WHERE r.promotion_id = p.id
            ORDER BY r.id DESC LIMIT 1) AS last_verdict
        FROM learning_promotions p
        JOIN learning_items i ON i.id = p.item_id
        WHERE p.state = 'in_review' AND i.state = 'candidate' AND i.owner_kind = p.owner_kind
        ORDER BY p.delivered_at, p.id`;
      let acted = 0;
      for (const promotion of waiting) {
        const key = flagKey(promotion.project_id, promotion.id);
        const text = reviewFlagText({
          failureMode: promotion.failure_mode,
          ownerKind: promotion.owner_kind,
          proposedBy: promotion.proposed_by,
          lastVerdict: promotion.last_verdict,
        });
        const standing = open.get(key);
        open.delete(key);
        if (standing === text) continue;
        acted += 1;
        if (dryRun) continue;
        yield* attention.raise({
          pluginId: PLUGIN_ID,
          threadId: key,
          kind: KIND,
          text,
          resumeAction: {
            label: "Review",
            target: "plugin",
            pluginId: PLUGIN_ID,
            tab: "items",
            recordId: String(promotion.item_id),
          },
        });
      }
      // What is left names no promotion waiting for review.
      for (const key of open.keys()) {
        acted += 1;
        if (!dryRun) yield* attention.clear({ pluginId: PLUGIN_ID, threadId: key, kind: KIND });
      }
      return { examined: waiting.length + open.size, acted, flags: waiting.length };
    });

  return { plugin: PLUGIN_ID, name: "reviews", run };
});

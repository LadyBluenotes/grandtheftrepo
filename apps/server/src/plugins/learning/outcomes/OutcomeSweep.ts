import type { LearningOwnerKind, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Attention from "../../Attention.ts";
import * as CorrectionStore from "../CorrectionStore.ts";
import {
  FLAG_KINDS,
  flagFor,
  flagKind,
  judge,
  latestComplete,
  respondedTo,
  type Verdict,
  windows,
} from "./compare.ts";

const PLUGIN_ID = "learning";
const RESUME_ACTION = { label: "Open learning", target: "settings" } as const;

/** The most promotions one tick judges; the rest wait for the next. */
const BATCH_SIZE = 100;

/**
 * A flag is per promotion, and carries the project as a segment so the board's strip lists it
 * (`kanban/attentionRows.ts`).
 */
const flagKey = (projectId: ProjectId, promotionId: number) =>
  `promotion:${projectId}:${promotionId}`;

const promotionOf = (key: string) => {
  const id = /:(\d+)$/.exec(key)?.[1];
  return id === undefined ? undefined : Number(id);
};

/**
 * Checks each delivered promotion's bet: did the handover reduce its failure mode? Once a
 * promotion's 28 days after delivery are complete, the sweep counts the project's corrections
 * declaring the item's failure mode in the 28 days before and after, judges it once (`judge`) and
 * writes the verdict to `promotion_outcome`. `ineffective` raises a `promotion_ineffective` flag
 * and `settled` a `promotion_settled` one, both keyed by promotion and project; nothing else
 * does. A promotion whose owner kind is `local_only` has no handover and is never judged. A
 * person who set the item's disposition after the delivery, closing it or sending it to another
 * owner kind, has already answered: that promotion is judged without a flag, and an open flag is
 * cleared on the next tick. The sweep never closes or reroutes an item.
 *
 * The flag is raised before the verdict is written, so a crash between them judges again and
 * raises the same flag. Open flags are checked first, then a tick judges up to a batch of
 * promotions, earliest delivered first. `examined` counts the open flags checked and the
 * promotions judged, `acted` the flags cleared and the verdicts written, `flags` the flags
 * standing after the tick. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attention = yield* Attention.Attention;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      let examined = 0;
      let acted = 0;
      let flags = 0;

      const open = (yield* Effect.forEach(Object.values(FLAG_KINDS), (kind) =>
        attention
          .listOpen({ pluginId: PLUGIN_ID, kind })
          .pipe(Effect.map((list) => list.map((flag) => ({ kind, key: flag.threadId })))),
      )).flat();
      const openIds = open.flatMap(({ key }) => promotionOf(key) ?? []);
      const standing =
        openIds.length === 0
          ? []
          : yield* sql<{
              readonly id: number;
              readonly verdict: Verdict;
              readonly delivered_at: string;
              readonly disposition_at: string | null;
            }>`SELECT o.promotion_id AS id, o.verdict, p.updated_at AS delivered_at, i.disposition_at
              FROM promotion_outcome o
              JOIN learning_promotions p ON p.id = o.promotion_id
              JOIN learning_items i ON i.id = p.item_id
              WHERE o.promotion_id IN ${sql.in(openIds)}`;
      const byId = new Map(standing.map((row) => [row.id, row]));
      for (const { kind, key } of open) {
        examined += 1;
        const id = promotionOf(key);
        const row = id === undefined ? undefined : byId.get(id);
        if (
          row !== undefined &&
          flagKind(row.verdict) === kind &&
          !respondedTo(row.delivered_at, row.disposition_at)
        ) {
          flags += 1;
          continue;
        }
        acted += 1;
        if (!dryRun) yield* attention.clear({ pluginId: PLUGIN_ID, threadId: key, kind });
      }

      const due = yield* sql<{
        readonly id: number;
        readonly project_id: ProjectId;
        readonly failure_mode: string;
        readonly owner_kind: LearningOwnerKind;
        readonly delivered_at: string;
        readonly disposition_at: string | null;
      }>`SELECT p.id, p.project_id, p.failure_mode, p.owner_kind, p.updated_at AS delivered_at,
          i.disposition_at
        FROM learning_promotions p
        JOIN learning_items i ON i.id = p.item_id
        LEFT JOIN promotion_outcome o ON o.promotion_id = p.id
        WHERE p.state = 'delivered' AND p.owner_kind != 'local_only'
          AND p.updated_at <= ${latestComplete(now)} AND o.promotion_id IS NULL
        ORDER BY p.updated_at, p.id
        LIMIT ${BATCH_SIZE}`;
      for (const promotion of due) {
        examined += 1;
        acted += 1;
        const around = windows(promotion.delivered_at);
        const counts = {
          before: yield* CorrectionStore.countDeclared({
            projectId: promotion.project_id,
            mode: promotion.failure_mode,
            ...around.before,
          }),
          after: yield* CorrectionStore.countDeclared({
            projectId: promotion.project_id,
            mode: promotion.failure_mode,
            ...around.after,
          }),
        };
        const verdict = judge(counts);
        const flag = respondedTo(promotion.delivered_at, promotion.disposition_at)
          ? null
          : flagFor(verdict, {
              failureMode: promotion.failure_mode,
              ownerKind: promotion.owner_kind,
              after: counts.after,
            });
        if (flag !== null) flags += 1;
        if (dryRun) continue;
        if (flag !== null) {
          yield* attention.raise({
            pluginId: PLUGIN_ID,
            threadId: flagKey(promotion.project_id, promotion.id),
            kind: flag.kind,
            text: flag.text,
            resumeAction: RESUME_ACTION,
          });
        }
        yield* sql`INSERT INTO promotion_outcome (promotion_id, judged_at, verdict)
          VALUES (${promotion.id}, ${DateTime.formatIso(now)}, ${verdict})
          ON CONFLICT (promotion_id) DO NOTHING`;
      }
      return { examined, acted, flags };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return { plugin: PLUGIN_ID, name: "outcomes", run };
});

import type { LearningOwnerKind, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as EventSink from "../../../orchestration-v2/EventSink.ts";
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

/** How long a tick waits for the reactor to catch up before it judges nothing. */
const CATCH_UP_WAIT = Duration.seconds(3);

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
 * Checks each adopted promotion's bet: did the handover reduce its failure mode? Once a
 * promotion's 28 days after adoption are complete, the sweep counts the project's corrections
 * declaring the item's failure mode in the 28 days before and after its adoption, judges it once
 * (`judge`) and writes the verdict to `promotion_outcome`. A promotion still in review, or turned
 * down, was never in effect and is not judged. `ineffective` raises a `promotion_ineffective` flag
 * and `settled` a `promotion_settled` one, both keyed by promotion and project; nothing else
 * does. A promotion whose owner kind is `local_only` has no handover and is never judged. A
 * person who set the item's disposition after the adoption, closing it or sending it to another
 * owner kind, has already answered: that promotion is judged without a flag, and an open flag is
 * cleared on the next tick, as is one whose promotion was rolled back. The sweep never closes or
 * reroutes an item.
 *
 * A verdict is permanent, so a promotion is judged only from complete corrections. `caughtUp` is
 * the drain of the reactor that records them: a tick judges nothing, and only counts the
 * promotions it held back as `examined`, until the reactor holds every committed event within
 * `CATCH_UP_WAIT` and its `host_reactor_failure` table is empty, since the reactor moves past an
 * event whose handler failed. Clearing flags does not wait: it reads no correction.
 *
 * The flag is raised before the verdict is written, so a crash between them judges again and
 * raises the same flag. Open flags are checked first, then a tick judges up to a batch of
 * promotions, earliest adopted first. `examined` counts the open flags checked and the
 * promotions judged or held back, `acted` the flags cleared and the verdicts written, `flags` the
 * flags standing after the tick. A dry run counts and writes nothing.
 */
export const sweep = (caughtUp: Effect.Effect<void, EventSink.EventSinkV2Error>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attention = yield* Attention.Attention;

    /**
     * Whether the corrections table holds everything the log committed: the reactor has caught up
     * (a log that cannot be read counts as not caught up) and has no failed event.
     */
    const correctionsComplete = Effect.gen(function* () {
      const inTime = yield* Effect.timeoutOption(caughtUp, CATCH_UP_WAIT).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("learning: the event log could not be read for outcomes", {
            cause,
          }).pipe(Effect.as(Option.none<void>())),
        ),
      );
      if (Option.isNone(inTime)) return false;
      const failures = yield* sql<{
        readonly failed: number;
      }>`SELECT COUNT(*) AS failed FROM host_reactor_failure`;
      return (failures[0]?.failed ?? 0) === 0;
    });

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
                readonly adopted_at: string;
                readonly disposition_at: string | null;
              }>`SELECT o.promotion_id AS id, o.verdict, p.adopted_at, i.disposition_at
              FROM promotion_outcome o
              JOIN learning_promotions p ON p.id = o.promotion_id
              JOIN learning_items i ON i.id = p.item_id
              WHERE o.promotion_id IN ${sql.in(openIds)} AND p.state = 'adopted'`;
        const byId = new Map(standing.map((row) => [row.id, row]));
        for (const { kind, key } of open) {
          examined += 1;
          const id = promotionOf(key);
          const row = id === undefined ? undefined : byId.get(id);
          if (
            row !== undefined &&
            flagKind(row.verdict) === kind &&
            !respondedTo(row.adopted_at, row.disposition_at)
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
          readonly adopted_at: string;
          readonly disposition_at: string | null;
        }>`SELECT p.id, p.project_id, p.failure_mode, p.owner_kind, p.adopted_at, i.disposition_at
        FROM learning_promotions p
        JOIN learning_items i ON i.id = p.item_id
        LEFT JOIN promotion_outcome o ON o.promotion_id = p.id
        WHERE p.state = 'adopted' AND p.owner_kind != 'local_only'
          AND p.adopted_at <= ${latestComplete(now)} AND o.promotion_id IS NULL
        ORDER BY p.adopted_at, p.id
        LIMIT ${BATCH_SIZE}`;
        if (due.length > 0 && !(yield* correctionsComplete)) {
          return { examined: examined + due.length, acted, flags };
        }
        for (const promotion of due) {
          examined += 1;
          acted += 1;
          const around = windows(promotion.adopted_at);
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
          const flag = respondedTo(promotion.adopted_at, promotion.disposition_at)
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

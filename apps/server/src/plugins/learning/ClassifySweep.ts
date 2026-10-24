import type { LearningDeclaredMode, LearningFailureKind, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { classify } from "./classify.ts";
import * as ItemStore from "./items/ItemStore.ts";

/** Corrections taken per run, oldest first, so a backlog spreads over ticks inside the time limit. */
const BATCH = 500;

/**
 * Classifies corrections nothing has looked at yet. A correction with a failure mode becomes
 * evidence on its project's item for that mode, keyed by the correction, and takes the mode as
 * its cause class; the others stay `unclassified` with the reason. Every one is marked, so none is
 * read twice, unless a mode was declared for it while the run held it: that one is left unread, and
 * the next run classifies it with the mode. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* ItemStore.ItemStore;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly id: number;
        readonly project_id: ProjectId;
        readonly failure_kind: LearningFailureKind;
        readonly declared_mode: LearningDeclaredMode | null;
        readonly description: string;
      }>`SELECT id, project_id, failure_kind, declared_mode, description FROM corrections
        WHERE classified_at IS NULL ORDER BY id LIMIT ${BATCH}`;
      const at = DateTime.formatIso(yield* DateTime.now);
      let acted = 0;
      for (const row of rows) {
        const { failureMode, reason } = classify({
          failureKind: row.failure_kind,
          declaredMode: row.declared_mode,
        });
        if (failureMode !== null) acted += 1;
        if (dryRun) continue;
        // Evidence before the mark: a crash between them strengthens again under the same key,
        // which adds nothing. The description only summarizes the evidence; no rule reads it.
        if (failureMode !== null) {
          yield* items.strengthen(
            row.project_id,
            failureMode,
            `correction:${row.id}`,
            row.description,
          );
        }
        // Only the mode it read: a mode declared since then stays unread for the next run.
        yield* sql`UPDATE corrections
          SET cause_class = ${failureMode ?? "unclassified"}, classification_reason = ${reason},
            classified_at = ${at}, updated_at = ${at}
          WHERE id = ${row.id} AND declared_mode IS ${row.declared_mode}`;
      }
      return { examined: rows.length, acted, flags: 0 };
    });

  return { plugin: "learning", name: "classify", run };
});

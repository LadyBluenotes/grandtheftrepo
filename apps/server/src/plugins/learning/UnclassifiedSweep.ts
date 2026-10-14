import type { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Attention from "../Attention.ts";
import * as CorrectionStore from "./CorrectionStore.ts";

const PLUGIN_ID = "learning";
const FLAG_KIND = "unowned_finding";
const RESUME_ACTION = { label: "Open learning", target: "settings" } as const;

/** How many days a correction may stay without a mode before it is flagged. */
const UNCLASSIFIED_AFTER_DAYS = 7;

/** One flag per project, keyed so the strip and the weekly report find it (`attentionKeys.ts`). */
const flagKey = (projectId: ProjectId) => `corrections:${projectId}`;

const flagText = (count: number) =>
  count === 1
    ? `1 correction has had no failure mode for over ${UNCLASSIFIED_AFTER_DAYS} days, so it counts toward no learning item; declare its mode under Learning, Corrections.`
    : `${count} corrections have had no failure mode for over ${UNCLASSIFIED_AFTER_DAYS} days, so they count toward no learning item; declare a mode for each under Learning, Corrections.`;

/**
 * Builds the unclassified sweep. Per project it counts the corrections the classify sweep left
 * `unclassified`, other than provider failures, that are `UNCLASSIFIED_AFTER_DAYS` old, and keeps
 * one `unowned_finding` flag with the count. Declaring a mode for one (`CorrectionStore.declare`)
 * hands it back to the classify sweep, which runs earlier in the same tick, so the count drops on
 * that tick and the flag clears once none is left. The text follows the count, and a tick that
 * finds what the last one found writes nothing. A dry run counts and writes nothing.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attention = yield* Attention.Attention;

  const run = ({ dryRun }: { readonly dryRun: boolean }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const before = DateTime.formatIso(DateTime.subtract(now, { days: UNCLASSIFIED_AFTER_DAYS }));
      const counts = yield* CorrectionStore.countUnclassified(before).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const { changes, standing } = yield* Attention.reconcile(attention, {
        pluginId: PLUGIN_ID,
        kind: FLAG_KIND,
        resumeAction: RESUME_ACTION,
        dryRun,
        judged: new Map(counts.map((row) => [flagKey(row.project_id), flagText(row.n)])),
        leave: () => false,
      });
      return {
        examined: counts.reduce((sum, row) => sum + row.n, 0),
        acted: dryRun ? 0 : changes,
        flags: standing,
      };
    });

  return { plugin: PLUGIN_ID, name: "unclassified", run };
});

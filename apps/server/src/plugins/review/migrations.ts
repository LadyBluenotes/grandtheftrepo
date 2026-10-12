import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

const verdicts: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The id is derived from the reviewer thread and the checkpoint, so the primary key is also the
  // rule that a thread reviews a checkpoint once. `correction_id` points into the learning
  // plugin's database, which this file cannot join. `invalidated_at` is written only by the
  // invalidation sweep.
  yield* sql`CREATE TABLE review_verdicts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    reviewed_thread_id TEXT NOT NULL,
    reviewer_thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('approve', 'changes_requested')),
    failure_mode TEXT,
    summary TEXT NOT NULL,
    correction_id INTEGER,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    CHECK ((outcome = 'changes_requested') = (failure_mode IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX review_verdicts_reviewed ON review_verdicts (reviewed_thread_id, created_at)`;
});

export const migrations = [
  [1, "Verdicts", verdicts],
] as const satisfies ReadonlyArray<PluginMigration>;

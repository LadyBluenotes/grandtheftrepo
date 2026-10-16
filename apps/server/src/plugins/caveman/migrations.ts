import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PluginMigration } from "../Plugin.ts";

/**
 * Imported `caveman learn` reports, the newest eight, and their sinks in rank order. A token
 * count is NULL when caveman did not report it. `source_mtime` (epoch milliseconds) and
 * `source_size` are the report file's when it was imported.
 */
export const migrations = [
  [
    1,
    "learn",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE caveman_learn_plan (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          generated_at TEXT NOT NULL,
          source TEXT NOT NULL,
          source_mtime INTEGER NOT NULL,
          source_size INTEGER NOT NULL,
          window_from TEXT NOT NULL,
          window_to TEXT NOT NULL,
          cave_score INTEGER NOT NULL,
          sessions_scanned INTEGER NOT NULL,
          spend_json TEXT,
          wrap_measured_json TEXT,
          caveats_json TEXT NOT NULL,
          imported_at TEXT NOT NULL
        )
      `;
      yield* sql`CREATE INDEX caveman_learn_plan_generated_at ON caveman_learn_plan (generated_at)`;
      yield* sql`
        CREATE TABLE caveman_learn_sink (
          plan_id INTEGER NOT NULL REFERENCES caveman_learn_plan(id) ON DELETE CASCADE,
          rank INTEGER NOT NULL,
          sink_id TEXT NOT NULL,
          class TEXT NOT NULL,
          framing TEXT NOT NULL,
          basis TEXT NOT NULL,
          title TEXT NOT NULL,
          tokens_per_turn INTEGER,
          tokens_observed INTEGER,
          tokens_per_day_rate INTEGER,
          suggestion TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          PRIMARY KEY (plan_id, rank)
        )
      `;
    }),
  ],
] as const satisfies ReadonlyArray<PluginMigration>;

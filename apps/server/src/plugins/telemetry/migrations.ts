import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/** One row per provider turn. A counter is NULL when the provider did not report it, never 0. */
export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "turn_usage",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE telemetry_turn_usage (
          provider_turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          input_tokens INTEGER,
          cached_input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          usage_updated_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        )
      `;
    }),
  ],
];

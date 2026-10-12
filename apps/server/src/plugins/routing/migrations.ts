import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PluginMigration } from "../Plugin.ts";

/**
 * `tier_map.scope` is `environment` or a project id. `routing_events` is append-only, one row per
 * event; `kind` names it and `detail` is its JSON. The kind-specific columns are nullable because
 * later kinds need not carry them.
 */
export const migrations = [
  [
    1,
    "tier_map",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE IF NOT EXISTS tier_map (
          scope TEXT NOT NULL,
          tier TEXT NOT NULL,
          provider_instance_id TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (scope, tier)
        )
      `;
    }),
  ],
  [
    2,
    "routing_events",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE routing_events (
          id INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          project_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          tier TEXT,
          provider_instance_id TEXT,
          model TEXT,
          detail TEXT NOT NULL
        )
      `;
    }),
  ],
] as const satisfies ReadonlyArray<PluginMigration>;

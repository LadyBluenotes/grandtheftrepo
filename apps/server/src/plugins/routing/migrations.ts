import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PluginMigration } from "../Plugin.ts";

/** `scope` is `environment` or a project id. */
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
] as const satisfies ReadonlyArray<PluginMigration>;

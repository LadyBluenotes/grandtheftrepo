import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PluginMigration } from "../Plugin.ts";

/**
 * `tier_map.scope` is `environment` or a project id. `routing_events` is append-only, one row per
 * event; `kind` names it and `detail` is its JSON. The kind-specific columns are nullable because
 * later kinds need not carry them. `recommendation_id` is the id of the `routing_recommended` row
 * a `routing_observed` row answers, unique among observed rows so a replay cannot add a second.
 * The other two indexes serve the adherence reactor (a thread's recommendation) and the adherence
 * report (a project's recommendations in a window, in time order).
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
  [
    3,
    "routing_observed",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE routing_events ADD COLUMN recommendation_id INTEGER`;
      yield* sql`
        CREATE UNIQUE INDEX routing_events_observed_recommendation
        ON routing_events (recommendation_id)
        WHERE kind = 'routing_observed'
      `;
      yield* sql`CREATE INDEX routing_events_thread ON routing_events (thread_id, kind)`;
      yield* sql`
        CREATE INDEX routing_events_project_kind_at ON routing_events (project_id, kind, at)
      `;
    }),
  ],
] as const satisfies ReadonlyArray<PluginMigration>;

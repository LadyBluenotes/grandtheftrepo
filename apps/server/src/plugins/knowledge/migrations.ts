import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "knowledge",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE knowledge_entry (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          "key" TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          state TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          accepted_at TEXT,
          retired_at TEXT
        )
      `;
      // A retired page frees its key, so a later proposal can take it.
      yield* sql`
        CREATE UNIQUE INDEX knowledge_entry_live_key ON knowledge_entry (project_id, "key")
        WHERE state <> 'retired'
      `;
      // One row per project and agent, replaced when an install records a new hash or path.
      yield* sql`
        CREATE TABLE knowledge_delivery (
          project_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          path TEXT NOT NULL,
          hash TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          verified_at TEXT,
          PRIMARY KEY (project_id, agent)
        )
      `;
    }),
  ],
];

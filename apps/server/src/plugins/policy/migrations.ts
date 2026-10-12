import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "policies",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The accepted version, else the latest draft; rebuilt from policy_versions after every change.
      yield* sql`
        CREATE TABLE policies (
          project_id TEXT NOT NULL,
          "key" TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          version INTEGER NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, "key")
        )
      `;
      // Append-only: a version's latest row is its state.
      yield* sql`
        CREATE TABLE policy_versions (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          "key" TEXT NOT NULL,
          version INTEGER NOT NULL,
          state TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          at TEXT NOT NULL
        )
      `;
      yield* sql`CREATE INDEX policy_versions_by_key ON policy_versions (project_id, "key", id)`;
      // One row per install, replaced by the next install for the same agent.
      yield* sql`
        CREATE TABLE deliveries (
          project_id TEXT NOT NULL,
          "key" TEXT NOT NULL,
          version INTEGER NOT NULL,
          agent TEXT NOT NULL,
          target_path TEXT NOT NULL,
          rendered_hash TEXT NOT NULL,
          rules_hash TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          verified_at TEXT,
          verification_method TEXT,
          PRIMARY KEY (project_id, "key", agent)
        )
      `;
    }),
  ],
];

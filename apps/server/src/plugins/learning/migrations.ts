import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

const corrections: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE corrections (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    failure_kind TEXT NOT NULL,
    cause_class TEXT NOT NULL,
    declared_mode TEXT,
    description TEXT NOT NULL,
    source_event_ids TEXT NOT NULL,
    source_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // A replay or retry inserts the same source again; the index makes that a no-op.
  yield* sql`CREATE UNIQUE INDEX corrections_source ON corrections (failure_kind, source_key)`;
  yield* sql`CREATE INDEX corrections_project_created ON corrections (project_id, created_at)`;
  // What the producers know about a thread, kept from thread events so nothing reads the core database.
  // `changes_requested` is a JSON array of the keys of its pull requests whose review asks for changes.
  yield* sql`CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0,
    changes_requested TEXT NOT NULL DEFAULT '[]'
  )`;
});

export const migrations = [
  [1, "Corrections", corrections],
] as const satisfies ReadonlyArray<PluginMigration>;

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/**
 * The kanban plugin's own file, `plugins/kanban.sqlite`. The board itself is markdown files; this
 * holds what is not a file.
 *
 * `stop` is the emergency stop: at most one row, present while it is set. The flags the writers
 * sweep raises live in the host's `attention` table, not here.
 *
 * `spec_attempt` holds each try at turning an issue into a spec. A `running` one waits for its
 * drafting thread's run to end, found by `child_thread_id`. `source_hash` is the hash of the
 * issue's creation time, title and description when the attempt started: the issue is admitted
 * only while it still has them.
 */
export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "stop",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE stop (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          set_at TEXT NOT NULL,
          set_by TEXT NOT NULL,
          reason TEXT
        )
      `;
    }),
  ],
  [
    2,
    "spec_attempt",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE spec_attempt (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          child_thread_id TEXT,
          status TEXT NOT NULL,
          text TEXT,
          reason TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `;
      yield* sql`CREATE INDEX spec_attempt_issue ON spec_attempt (project_id, issue_id, id)`;
      yield* sql`
        CREATE INDEX spec_attempt_running ON spec_attempt (child_thread_id)
        WHERE status = 'running'
      `;
    }),
  ],
];

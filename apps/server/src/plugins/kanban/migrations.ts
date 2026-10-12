import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/**
 * The kanban plugin's own file, `plugins/kanban.sqlite`. The board itself is markdown files; this
 * holds what is not a file.
 *
 * `stop` is the emergency stop: at most one row, present while it is set. `attention` is the list
 * of things waiting on a person that a sweep raises and clears (shape from issue #30); a flag is
 * open while `cleared_at` is null, and at most one is open per plugin, thread and kind.
 */
export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "stop_attention",
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
      yield* sql`
        CREATE TABLE attention (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          resume_action TEXT NOT NULL,
          cleared_at TEXT
        )
      `;
      yield* sql`
        CREATE UNIQUE INDEX attention_open ON attention (plugin_id, thread_id, kind)
        WHERE cleared_at IS NULL
      `;
    }),
  ],
];

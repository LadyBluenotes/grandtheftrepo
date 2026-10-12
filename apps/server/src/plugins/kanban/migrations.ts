import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/**
 * The kanban plugin's own file, `plugins/kanban.sqlite`. The board itself is markdown files; this
 * holds what is not a file.
 *
 * `stop` is the emergency stop: at most one row, present while it is set. The flags the writers
 * sweep raises live in the host's `attention` table, not here.
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
];

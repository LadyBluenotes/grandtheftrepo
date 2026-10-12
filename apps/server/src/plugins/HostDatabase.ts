import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import type { PluginMigration } from "./Plugin.ts";
import * as PluginDatabase from "./PluginDatabase.ts";

/**
 * The host's own file, `plugins/_host.sqlite`: one row per supervisor tick and one per sweep it
 * ran, and the attention flags any plugin raises through `Attention`. Every table the host owns is
 * migrated here, in one list, because migration ids are per file.
 *
 * An attention flag is open while `cleared_at` is null, and at most one is open per plugin, thread
 * and kind (shape from issue #30).
 */
export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "supervisor",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE host_supervisor_tick (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          dry_run INTEGER NOT NULL
        )
      `;
      yield* sql`
        CREATE INDEX host_supervisor_tick_started_at ON host_supervisor_tick (started_at)
      `;
      yield* sql`
        CREATE TABLE host_supervisor_sweep (
          tick_id INTEGER NOT NULL REFERENCES host_supervisor_tick(id) ON DELETE CASCADE,
          plugin TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          examined INTEGER NOT NULL,
          acted INTEGER NOT NULL,
          flags INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          error TEXT
        )
      `;
      yield* sql`CREATE INDEX host_supervisor_sweep_tick ON host_supervisor_sweep(tick_id)`;
    }),
  ],
  [
    2,
    "attention",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE attention (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plugin_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          resume_action TEXT NOT NULL,
          raised_at TEXT NOT NULL,
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

/** The one connection to `plugins/_host.sqlite`, shared by the supervisor and `Attention`. */
export class HostDatabase extends Context.Service<HostDatabase, SqlClient.SqlClient>()(
  "t3/plugins/HostDatabase",
) {}

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsDir = path.join(stateDir, "plugins");
  yield* fs.makeDirectory(pluginsDir, { recursive: true });
  const { sql } = yield* PluginDatabase.open({
    id: "_host",
    filename: path.join(pluginsDir, "_host.sqlite"),
    migrations,
  });
  return sql;
});

export const layer = Layer.effect(HostDatabase, make);

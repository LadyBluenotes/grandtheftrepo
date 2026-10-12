import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { WAL_SIZE_LIMIT_BYTES } from "../persistence/Sqlite.ts";
import type { PluginMigration } from "./Plugin.ts";

/**
 * Opens one plugin's own SQLite database and brings its schema up to date.
 * `Sqlite.ts` is not reused on purpose: its layers end by running the core
 * migrations, which would put every core table into the plugin's file. The
 * same PRAGMAs apply, and the Effect migrator records applied ids in the
 * file's own `effect_sql_migrations`, so a plugin's migration history never
 * meets the core's. All pending migrations run in one transaction; a failure
 * rolls every one of them back.
 *
 * The client lives for the enclosing scope; `:memory:` gives a throwaway
 * database for tests and for plugins that declare no migrations.
 */
export const open = Effect.fn("PluginDatabase.open")(function* (options: {
  readonly id: string;
  readonly filename: string;
  readonly migrations: ReadonlyArray<PluginMigration>;
}) {
  const services = yield* Layer.build(
    NodeSqliteClient.layer({
      filename: options.filename,
      spanAttributes: { "db.name": `plugin:${options.id}`, "service.name": "t3code-server" },
    }),
  );
  const sql = Context.get(services, SqlClient.SqlClient);
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
  const executed = yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(options.migrations.map(([id, name, up]) => [`${id}_${name}`, up])),
    ),
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  return { sql, executed };
});

/** A throwaway database for a plugin the host did not open one for, such as under a mocked host. */
export const layerMemory = (id: string) =>
  Layer.effect(
    SqlClient.SqlClient,
    open({ id, filename: ":memory:", migrations: [] }).pipe(
      Effect.map((opened) => opened.sql),
      // Nothing to migrate and no file: a failure here is a broken SQLite build, not plugin state.
      Effect.orDie,
    ),
  );

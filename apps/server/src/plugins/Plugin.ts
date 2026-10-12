import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";

/**
 * One numbered change to a plugin's schema, in the shape of the core `migrationEntries`.
 * A shipped migration is never edited: the migrator skips ids it has recorded, so a fix is a
 * new, higher id.
 */
export type PluginMigration = readonly [
  id: number,
  name: string,
  up: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
];

/**
 * What a plugin contributes to the server. The host decides whether it runs
 * and wires it in; a plugin never edits an upstream file.
 */
export interface ServerPlugin<R = never> {
  readonly id: string;
  /** Ids of plugins that must run for this one to run. */
  readonly dependsOn: ReadonlyArray<string>;
  /**
   * Schema of the plugin's own SQLite file, `<stateDir>/plugins/<id>.sqlite`, applied before the
   * plugin starts. Without it the plugin's `SqlClient` is in memory and empty at every start.
   */
  readonly migrations?: ReadonlyArray<PluginMigration>;
  /**
   * Services, reactors and sweeps. Built only when the plugin is active, with
   * `SqlClient.SqlClient` bound to the plugin's own database, never the core one.
   */
  readonly layer: Layer.Layer<never, never, R | SqlClient.SqlClient>;
  /**
   * MCP tools. `register` is `McpHttpServer.toolkitRegistration`, handed in because that module
   * imports the host: importing it from a plugin would make a cycle.
   */
  readonly mcp?: (
    register: typeof toolkitRegistration,
  ) => Layer.Layer<never, never, R | SqlClient.SqlClient>;
}

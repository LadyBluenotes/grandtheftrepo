import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/**
 * 1: one row per provider turn. A counter is NULL when the provider did not report it, never 0.
 * 2: the runs, tool calls and threads the measures read, and the run each provider turn
 * belongs to. The reactor fills every column through `fields.ts`. `event_sequence` is the
 * sequence of the event a row was last written from, so a retried older event cannot overwrite it.
 */
export const migrations: ReadonlyArray<PluginMigration> = [
  [
    1,
    "turn_usage",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE telemetry_turn_usage (
          provider_turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          input_tokens INTEGER,
          cached_input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          usage_updated_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        )
      `;
    }),
  ],
  [
    2,
    "measure_inputs",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE telemetry_turn_usage ADD COLUMN run_id TEXT`;
      // Rows from migration 1 take 0; the replay below rewrites them from their events.
      yield* sql`ALTER TABLE telemetry_turn_usage ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0`;
      yield* sql`CREATE INDEX telemetry_turn_usage_thread ON telemetry_turn_usage (thread_id)`;
      yield* sql`
        CREATE TABLE telemetry_runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL,
          model TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          event_sequence INTEGER NOT NULL
        )
      `;
      yield* sql`CREATE INDEX telemetry_runs_thread ON telemetry_runs (thread_id)`;
      yield* sql`
        CREATE TABLE telemetry_tool_calls (
          item_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          item_type TEXT NOT NULL,
          tool_name TEXT,
          path TEXT,
          status TEXT NOT NULL,
          event_sequence INTEGER NOT NULL
        )
      `;
      yield* sql`CREATE INDEX telemetry_tool_calls_thread ON telemetry_tool_calls (thread_id)`;
      // `settled_at` and `unsettled_at` keep the latest settle and reopen, so a reopen stays
      // visible after the thread settles again. `settled_by_sweep` is NULL while who settled is
      // unknown: a settlement learned from an event other than `thread.settled`.
      yield* sql`
        CREATE TABLE telemetry_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          parent_thread_id TEXT,
          settled_at TEXT,
          settled_by_sweep INTEGER,
          unsettled_at TEXT,
          pull_request_merged_at TEXT
        )
      `;
      yield* sql`CREATE INDEX telemetry_threads_project ON telemetry_threads (project_id)`;
      // The reactor has passed every event these tables need. Without its cursor it starts over
      // from the first event; every handler is an upsert, so the replay only fills the new rows.
      // Old failures go with it: the replay records again any that still fail, and a given-up
      // row left behind would keep the measures unavailable for good.
      yield* sql`DROP TABLE IF EXISTS host_reactor_cursor`;
      yield* sql`DROP TABLE IF EXISTS host_reactor_failure`;
    }),
  ],
];

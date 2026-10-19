import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

/**
 * 1: one row per provider turn. A counter is NULL when the provider did not report it, never 0.
 * 2: the runs, tool calls and threads the measures read, and the run each provider turn
 * belongs to. The reactor fills every column through `fields.ts`. `event_sequence` is the
 * sequence of the event a row was last written from, so a retried older event cannot overwrite it.
 * 3: the provider instance of each run, which places it on a routing tier, and budgets with the
 * breaches and recoveries their sweep records.
 * 4: the size of each tool call's output, the head of a command's command line and the time of
 * its item, which the tool output measures read, tool calls with no run, which a provider's
 * subagent makes, and the budget on the largest single result.
 * 5: what the repeated work measures shape a tool call by: the provider turn that groups a call
 * with no run, a search's pattern, a dynamic tool's input keys, and the input's size and digest.
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
  [
    3,
    "budgets",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // NULL until the replay below rewrites the run from its events.
      yield* sql`ALTER TABLE telemetry_runs ADD COLUMN provider_instance_id TEXT`;
      // A null `project_id` judges every project, one by one.
      yield* sql`
        CREATE TABLE budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          measure TEXT NOT NULL,
          tier TEXT NOT NULL,
          threshold REAL NOT NULL,
          direction TEXT NOT NULL,
          project_id TEXT,
          min_sample INTEGER NOT NULL,
          enabled INTEGER NOT NULL
        )
      `;
      // A budget's state in a project is its newest event there, by id.
      yield* sql`
        CREATE TABLE budget_events (
          id INTEGER PRIMARY KEY,
          budget_id INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          window_from TEXT NOT NULL,
          window_to TEXT NOT NULL,
          value REAL NOT NULL,
          threshold REAL NOT NULL,
          sample_size INTEGER NOT NULL,
          occurred_at TEXT NOT NULL
        )
      `;
      yield* sql`CREATE INDEX budget_events_budget ON budget_events (budget_id, project_id)`;
      yield* sql`CREATE INDEX budget_events_project ON budget_events (project_id, occurred_at)`;
      // Output tokens per turn for each tier, as placeholders to tune.
      yield* sql`
        INSERT INTO budgets (measure, tier, threshold, direction, project_id, min_sample, enabled)
        VALUES
          ('context_efficiency', 'cheap', 800, 'lower_is_better', NULL, 20, 1),
          ('context_efficiency', 'standard', 1500, 'lower_is_better', NULL, 20, 1),
          ('context_efficiency', 'strong', 3000, 'lower_is_better', NULL, 20, 1)
      `;
      // As in migration 2: without its cursor the reactor replays from the first event, and
      // every run upsert fills the new column.
      yield* sql`DROP TABLE IF EXISTS host_reactor_cursor`;
      yield* sql`DROP TABLE IF EXISTS host_reactor_failure`;
    }),
  ],
  [
    4,
    "tool_output",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The table gets its final shape in one step. SQLite cannot drop NOT NULL from `run_id`,
      // which a provider's subagent's calls need, so the table is built again and the rows copied,
      // keeping the calls whose events a compaction has since removed. New columns: `command`,
      // the head of a command line; `output_tokens`, NULL for an item with no output to size, such
      // as a file change; `item_at`, when the item started or else last changed, which places a
      // call that has no run in a window. All three are NULL until the replay below rewrites the
      // row from its event.
      yield* sql`
        CREATE TABLE telemetry_tool_calls_v4 (
          item_id TEXT PRIMARY KEY,
          run_id TEXT,
          thread_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          item_type TEXT NOT NULL,
          tool_name TEXT,
          path TEXT,
          command TEXT,
          output_tokens INTEGER,
          item_at TEXT,
          status TEXT NOT NULL,
          event_sequence INTEGER NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO telemetry_tool_calls_v4
          (item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status, event_sequence)
        SELECT item_id, run_id, thread_id, ordinal, item_type, tool_name, path, status,
          event_sequence
        FROM telemetry_tool_calls
      `;
      yield* sql`DROP TABLE telemetry_tool_calls`;
      yield* sql`ALTER TABLE telemetry_tool_calls_v4 RENAME TO telemetry_tool_calls`;
      yield* sql`CREATE INDEX telemetry_tool_calls_thread ON telemetry_tool_calls (thread_id)`;
      // The measure reads no tier, so the sweep asks for it without one and this one row, kept on
      // `standard` because a budget needs a tier, judges every run.
      yield* sql`
        INSERT INTO budgets (measure, tier, threshold, direction, project_id, min_sample, enabled)
        VALUES ('tool_output_max_per_call', 'standard', 8000, 'lower_is_better', NULL, 20, 1)
      `;
      // As in migration 2: without its cursor the reactor replays from the first event, and
      // every tool call upsert fills the new columns, including the calls it used to skip for want
      // of a run.
      yield* sql`DROP TABLE IF EXISTS host_reactor_cursor`;
      yield* sql`DROP TABLE IF EXISTS host_reactor_failure`;
    }),
  ],
  [
    5,
    "repeated_work",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // NULL until the replay below rewrites the row from its event, and for good on a call whose
      // event a compaction has removed; the measures leave such a call unshaped. `input_digest` is
      // the sha256 of the call's input, which tells two equal inputs apart without keeping either.
      yield* sql`ALTER TABLE telemetry_tool_calls ADD COLUMN provider_turn_id TEXT`;
      yield* sql`ALTER TABLE telemetry_tool_calls ADD COLUMN pattern TEXT`;
      yield* sql`ALTER TABLE telemetry_tool_calls ADD COLUMN input_keys TEXT`;
      yield* sql`ALTER TABLE telemetry_tool_calls ADD COLUMN input_tokens INTEGER`;
      yield* sql`ALTER TABLE telemetry_tool_calls ADD COLUMN input_digest TEXT`;
      // As in migration 2: without its cursor the reactor replays from the first event, and
      // every tool call upsert fills the new columns.
      yield* sql`DROP TABLE IF EXISTS host_reactor_cursor`;
      yield* sql`DROP TABLE IF EXISTS host_reactor_failure`;
    }),
  ],
];

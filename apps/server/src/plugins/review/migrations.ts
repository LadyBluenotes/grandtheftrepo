import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { PluginMigration } from "../Plugin.ts";

const verdicts: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The id is derived from the reviewer thread and the checkpoint, so the primary key is also the
  // rule that a thread reviews a checkpoint once. `correction_id` points into the learning
  // plugin's database, which this file cannot join. `invalidated_at` is written only by the
  // invalidation sweep.
  yield* sql`CREATE TABLE review_verdicts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    reviewed_thread_id TEXT NOT NULL,
    reviewer_thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('approve', 'changes_requested')),
    failure_mode TEXT,
    summary TEXT NOT NULL,
    correction_id INTEGER,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    CHECK ((outcome = 'changes_requested') = (failure_mode IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX review_verdicts_reviewed ON review_verdicts (reviewed_thread_id, created_at)`;
});

// Telemetry reads a project's verdicts by time, oldest first and ties by id, so the index serves
// the range and the order without a sort.
const projectWindow: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX review_verdicts_project_created
    ON review_verdicts (project_id, created_at, id)`;
});

// A request names the checkpoint it was made at. `stale` is final: `stale_at` and `superseded_by`
// are set together, when the invalidation sweep opens the request that replaces it. The partial
// index is the sweep's batch, the threads with a request still standing; `superseded_by` finds
// the stale requests one names, for the flag that follows them.
const requests: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE review_request (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'stale')),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    stale_at TEXT,
    superseded_by INTEGER REFERENCES review_request (id),
    CHECK ((status = 'stale') = (stale_at IS NOT NULL AND superseded_by IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX review_request_thread ON review_request (thread_id, requested_at)`;
  yield* sql`CREATE INDEX review_request_standing ON review_request (thread_id)
    WHERE status IN ('open', 'answered')`;
  yield* sql`CREATE INDEX review_request_superseded ON review_request (superseded_by)`;
});

// A project with no `security_mode` row is `warn`. One finding per checkpoint, pattern, file and
// line, so a replayed scan inserts nothing. `blocking` is whether the project was in `block` when
// the finding was recorded: the thread is held while one such finding is unacknowledged.
// `correction_id` points into the learning plugin's database and is written by the security sweep;
// the partial index is that sweep's batch.
const security: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE security_mode (
    project_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'warn', 'block'))
  )`;
  yield* sql`CREATE TABLE security_finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    pattern_id TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
    correction_id INTEGER,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    ack_reason TEXT,
    CHECK ((acknowledged_at IS NULL) = (ack_reason IS NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX security_finding_key
    ON security_finding (checkpoint_id, pattern_id, file, line)`;
  yield* sql`CREATE INDEX security_finding_thread ON security_finding (thread_id, acknowledged_at)`;
  yield* sql`CREATE INDEX security_finding_uncorrected ON security_finding (id)
    WHERE correction_id IS NULL`;
});

export const migrations = [
  [1, "Verdicts", verdicts],
  [2, "ProjectWindow", projectWindow],
  [3, "Requests", requests],
  [4, "Security", security],
] as const satisfies ReadonlyArray<PluginMigration>;

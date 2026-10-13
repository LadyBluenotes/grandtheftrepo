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

const learningItems: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The classify sweep takes rows with no `classified_at`; the reason says why a row has its class.
  yield* sql`ALTER TABLE corrections ADD COLUMN classified_at TEXT`;
  yield* sql`ALTER TABLE corrections ADD COLUMN classification_reason TEXT`;
  yield* sql`CREATE INDEX corrections_unclassified ON corrections (id) WHERE classified_at IS NULL`;
  // One item per recurring failure mode per project; `occurrences` is its evidence row count.
  yield* sql`CREATE TABLE learning_items (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    failure_mode TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    state TEXT NOT NULL,
    owner_kind TEXT,
    disposition_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, failure_mode)
  )`;
  yield* sql`CREATE TABLE learning_item_evidence (
    item_id INTEGER NOT NULL REFERENCES learning_items (id),
    evidence_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (item_id, evidence_key)
  )`;
  // At most one handover per project, failure mode and owner kind, whatever happens to the item.
  yield* sql`CREATE TABLE learning_promotions (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES learning_items (id),
    project_id TEXT NOT NULL,
    failure_mode TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, failure_mode, owner_kind)
  )`;
});

// The promote sweep reads candidates by state and owner kind, and due promotions by state, owner
// kind and time, one batch at a time.
const promoteIndexes: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX learning_items_state_owner ON learning_items (state, owner_kind)`;
  yield* sql`CREATE INDEX learning_promotions_due
    ON learning_promotions (state, owner_kind, next_attempt_at)`;
});

// The regression sweep writes a project's row once every measure of the window starting at
// `window_from` was compared, and skips a project that has one. It reads by window, so the key
// leads with it.
const regressionRuns: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE regression_runs (
    project_id TEXT NOT NULL,
    window_from TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    PRIMARY KEY (window_from, project_id)
  )`;
});

// When a person set an item's disposition. `updated_at` also moves with every new piece of
// evidence, so it cannot say when a decision was made. Choices made before this column existed
// keep NULL: their time is not known.
const dispositionAt: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE learning_items ADD COLUMN disposition_at TEXT`;
});

// The outcome sweep judges a delivered promotion once, when its after window is complete, and
// writes the verdict here. A row means the promotion was judged, whether or not it raised a flag.
const promotionOutcome: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE promotion_outcome (
    promotion_id INTEGER PRIMARY KEY REFERENCES learning_promotions (id),
    judged_at TEXT NOT NULL,
    verdict TEXT NOT NULL
  )`;
});

export const migrations = [
  [1, "Corrections", corrections],
  [2, "LearningItems", learningItems],
  [3, "PromoteIndexes", promoteIndexes],
  [4, "RegressionRuns", regressionRuns],
  [5, "DispositionAt", dispositionAt],
  [6, "PromotionOutcome", promotionOutcome],
] as const satisfies ReadonlyArray<PluginMigration>;

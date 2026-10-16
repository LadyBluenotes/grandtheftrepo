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

// Security corrections recorded before the security scan declared its mode stayed `unclassified`;
// declaring it now and clearing the mark hands them to the classify sweep like new ones.
const securityDeclaredMode: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE corrections
    SET declared_mode = 'security', cause_class = 'unclassified', classified_at = NULL,
      classification_reason = NULL
    WHERE failure_kind = 'security' AND declared_mode IS NULL`;
});

// A promotion is reviewed before it is adopted. `pending` becomes `proposed`; a written draft is
// `in_review` until someone other than its proposer adopts or rejects it, and an adopted one can be
// rolled back. Its proposer is a person (`user`) when a person routed the item, else the rules
// (`supervisor`). A record delivered before reviews existed was acted on as adopted, so it is
// adopted at its delivery time, which keeps its outcome window where it was.
const promotionReview: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE learning_promotions
    ADD COLUMN proposed_by TEXT NOT NULL DEFAULT 'supervisor'`;
  yield* sql`ALTER TABLE learning_promotions ADD COLUMN delivered_at TEXT`;
  yield* sql`ALTER TABLE learning_promotions ADD COLUMN adopted_at TEXT`;
  yield* sql`ALTER TABLE learning_promotions ADD COLUMN rolled_back_at TEXT`;
  yield* sql`ALTER TABLE learning_promotions ADD COLUMN rolled_back_by TEXT`;
  yield* sql`UPDATE learning_promotions SET proposed_by = 'user'
    WHERE item_id IN (SELECT id FROM learning_items WHERE disposition_by = 'person')`;
  yield* sql`UPDATE learning_promotions SET state = 'proposed' WHERE state = 'pending'`;
  yield* sql`UPDATE learning_promotions
    SET state = 'adopted', delivered_at = updated_at, adopted_at = updated_at
    WHERE state = 'delivered'`;
  yield* sql`CREATE TABLE promotion_reviews (
    id INTEGER PRIMARY KEY,
    promotion_id INTEGER NOT NULL REFERENCES learning_promotions (id),
    verdict TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX promotion_reviews_promotion ON promotion_reviews (promotion_id)`;
});

// The prompt library. `prompts` holds the latest version's text, so a list reads one table;
// `prompt_versions` is append-only. `source_key` names what proposed a prompt, such as a learning
// promotion, so a repeat of that proposal finds it; a key is unique within its project, since a
// source such as repeated work can name the same key in two. `accepted_at` is set once a person
// accepted or saved it, and decides whether unarchiving makes it active again or proposed.
const prompts: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE prompts (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    origin TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    source_key TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX prompts_project ON prompts (project_id, updated_at)`;
  yield* sql`CREATE UNIQUE INDEX prompts_source ON prompts (project_id, source_key)`;
  yield* sql`CREATE TABLE prompt_versions (
    prompt_id INTEGER NOT NULL REFERENCES prompts (id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (prompt_id, version)
  )`;
});

// The weekly review of repeated work. A proposal is one extraction candidate in one week; its
// `candidate` is the candidate as telemetry answered it, steps and example included but never a
// script's text, which telemetry does not keep. `draft` names what the proposal saved in its form's
// target, or holds a project script, which has no draft of its own. A project's row in
// `deterministic_runs` means its week starting at `window_from` was reviewed.
const deterministicProposals: PluginMigration[2] = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE deterministic_proposals (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    form TEXT NOT NULL,
    candidate TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    window_from TEXT NOT NULL,
    state TEXT NOT NULL,
    draft TEXT,
    waiting_reason TEXT,
    decided_by TEXT,
    decided_at TEXT,
    dismiss_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, candidate_id, window_from)
  )`;
  yield* sql`CREATE TABLE deterministic_runs (
    project_id TEXT NOT NULL,
    window_from TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    PRIMARY KEY (window_from, project_id)
  )`;
});

export const migrations = [
  [1, "Corrections", corrections],
  [2, "LearningItems", learningItems],
  [3, "PromoteIndexes", promoteIndexes],
  [4, "RegressionRuns", regressionRuns],
  [5, "DispositionAt", dispositionAt],
  [6, "PromotionOutcome", promotionOutcome],
  [7, "SecurityDeclaredMode", securityDeclaredMode],
  [8, "PromotionReview", promotionReview],
  [9, "Prompts", prompts],
  [10, "DeterministicProposals", deterministicProposals],
] as const satisfies ReadonlyArray<PluginMigration>;

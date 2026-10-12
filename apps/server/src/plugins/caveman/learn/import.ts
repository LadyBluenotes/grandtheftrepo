import type {
  CavemanLearnClass,
  CavemanLearnFinding,
  CavemanLearnFindings,
  CavemanLearnFraming,
  CavemanLearnPlan,
  CavemanLearnSink,
  CavemanLearnSource,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { Plan } from "./Plan.ts";

/** How many plans are kept; an import deletes the older ones. */
const KEEP = 8;

/** The report file a plan was read from, as it was when read. */
export interface ReportFile {
  readonly source: CavemanLearnSource;
  /** Epoch milliseconds. */
  readonly mtime: number;
  readonly size: number;
}

const CaveatsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const JsonText = Schema.fromJsonString(Schema.Json);
const EvidenceJson = Schema.fromJsonString(Schema.JsonObject);
const encodeCaveats = Schema.encodeSync(CaveatsJson);
const encodeJson = Schema.encodeSync(JsonText);
const encodeEvidence = Schema.encodeSync(EvidenceJson);
// Only `importPlan` writes these columns, so text that does not decode is a defect.
const decodeCaveats = Schema.decodeUnknownSync(CaveatsJson);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const decodeEvidence = Schema.decodeUnknownSync(EvidenceJson);

interface PlanRow {
  readonly id: number;
  readonly generated_at: string;
  readonly source: CavemanLearnSource;
  readonly window_from: string;
  readonly window_to: string;
  readonly cave_score: number;
  readonly sessions_scanned: number;
  readonly spend_json: string | null;
  readonly wrap_measured_json: string | null;
  readonly caveats_json: string;
  readonly imported_at: string;
}

interface FindingRow {
  readonly rank: number;
  readonly sink_id: string;
  readonly title: string;
  readonly class: CavemanLearnClass;
  readonly framing: CavemanLearnFraming;
  readonly basis: string;
  readonly tokens_per_turn: number | null;
  readonly tokens_observed: number | null;
  readonly tokens_per_day_rate: number | null;
  readonly suggestion: string;
}

const toPlan = (row: PlanRow): CavemanLearnPlan => ({
  generatedAt: row.generated_at,
  source: row.source,
  windowFrom: row.window_from,
  windowTo: row.window_to,
  caveScore: row.cave_score,
  sessionsScanned: row.sessions_scanned,
  caveats: decodeCaveats(row.caveats_json),
  spend: row.spend_json === null ? null : decodeJson(row.spend_json),
  wrapMeasured: row.wrap_measured_json === null ? null : decodeJson(row.wrap_measured_json),
  importedAt: row.imported_at,
});

const toFinding = (row: FindingRow): CavemanLearnFinding => ({
  rank: row.rank,
  sinkId: row.sink_id,
  title: row.title,
  class: row.class,
  framing: row.framing,
  basis: row.basis,
  tokensPerTurn: row.tokens_per_turn,
  tokensObserved: row.tokens_observed,
  tokensPerDayRate: row.tokens_per_day_rate,
  suggestion: row.suggestion,
});

const generatedAt = (plan: Plan) => DateTime.formatIso(plan.generated_at);

const newestPlanRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<PlanRow>`
    SELECT id, generated_at, source, window_from, window_to, cave_score, sessions_scanned,
      spend_json, wrap_measured_json, caveats_json, imported_at
    FROM caveman_learn_plan ORDER BY generated_at DESC, id DESC LIMIT 1
  `;
  return rows[0];
});

/** Whether `plan` was generated after every stored plan, which is when `importPlan` stores it. */
export const isNewer = (plan: Plan) =>
  Effect.map(
    newestPlanRow,
    (newest) => newest === undefined || generatedAt(plan) > newest.generated_at,
  );

/**
 * Stores `plan` with its sinks, ranked from 1 in the report's order, when it is newer than every
 * stored plan, then deletes all but the newest eight with their sinks. Answers whether it stored it.
 */
export const importPlan = (plan: Plan, file: ReportFile) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* isNewer(plan))) return false;
        const importedAt = DateTime.formatIso(yield* DateTime.now);
        const spend = plan.spend ?? null;
        const wrapMeasured = plan.wrap_measured ?? null;
        const inserted = yield* sql<{ readonly id: number }>`
          INSERT INTO caveman_learn_plan
            (generated_at, source, source_mtime, source_size, window_from, window_to, cave_score,
             sessions_scanned, spend_json, wrap_measured_json, caveats_json, imported_at)
          VALUES
            (${generatedAt(plan)}, ${file.source}, ${file.mtime}, ${file.size}, ${plan.window.from},
             ${plan.window.to}, ${plan.cave_score.score}, ${plan.sessions_scanned},
             ${spend === null ? null : encodeJson(spend)},
             ${wrapMeasured === null ? null : encodeJson(wrapMeasured)},
             ${encodeCaveats(plan.caveats ?? [])}, ${importedAt})
          RETURNING id
        `;
        const planId = inserted[0]!.id;
        for (const [index, sink] of (plan.sinks ?? []).entries()) {
          yield* sql`
            INSERT INTO caveman_learn_sink
              (plan_id, rank, sink_id, class, framing, basis, title, tokens_per_turn,
               tokens_observed, tokens_per_day_rate, suggestion, evidence_json)
            VALUES
              (${planId}, ${index + 1}, ${sink.sink_id}, ${sink.class}, ${sink.framing},
               ${sink.basis}, ${sink.title}, ${sink.tokens_per_turn ?? null},
               ${sink.tokens_observed ?? null}, ${sink.tokens_per_day_rate ?? null},
               ${sink.suggestion}, ${encodeEvidence(sink.evidence ?? {})})
          `;
        }
        yield* sql`
          DELETE FROM caveman_learn_plan WHERE id NOT IN (
            SELECT id FROM caveman_learn_plan ORDER BY generated_at DESC, id DESC LIMIT ${KEEP}
          )
        `;
        return true;
      }),
    );
  });

/** The file each source's newest stored plan was read from. */
export const storedFiles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly source: CavemanLearnSource;
    readonly source_mtime: number;
    readonly source_size: number;
  }>`
    SELECT source, source_mtime, source_size FROM caveman_learn_plan AS plan
    WHERE id = (
      SELECT id FROM caveman_learn_plan WHERE source = plan.source
      ORDER BY generated_at DESC, id DESC LIMIT 1
    )
  `;
  return rows.map((row): ReportFile => ({
    source: row.source,
    mtime: row.source_mtime,
    size: row.source_size,
  }));
});

/** The newest plan with every sink and its evidence, in rank order; undefined before the first import. */
export const latest = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const plan = yield* newestPlanRow;
  if (plan === undefined) return undefined;
  const rows = yield* sql<FindingRow & { readonly evidence_json: string }>`
    SELECT rank, sink_id, title, class, framing, basis, tokens_per_turn, tokens_observed,
      tokens_per_day_rate, suggestion, evidence_json
    FROM caveman_learn_sink WHERE plan_id = ${plan.id} ORDER BY rank
  `;
  return {
    plan: toPlan(plan),
    sinks: rows.map((row): CavemanLearnSink => ({
      ...toFinding(row),
      evidence: decodeEvidence(row.evidence_json),
    })),
  };
});

/** The newest plan and its first `limit` findings. Evidence is never read. */
export const findings = (limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* newestPlanRow;
    if (plan === undefined) return { plan: null, findings: [] } satisfies CavemanLearnFindings;
    const rows = yield* sql<FindingRow>`
      SELECT rank, sink_id, title, class, framing, basis, tokens_per_turn, tokens_observed,
        tokens_per_day_rate, suggestion
      FROM caveman_learn_sink WHERE plan_id = ${plan.id} ORDER BY rank LIMIT ${limit}
    `;
    return { plan: toPlan(plan), findings: rows.map(toFinding) } satisfies CavemanLearnFindings;
  });

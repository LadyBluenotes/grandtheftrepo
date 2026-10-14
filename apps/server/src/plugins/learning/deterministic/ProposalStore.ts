import {
  DETERMINISTIC_PROPOSALS_LIMIT,
  DeterministicDraft,
  type DeterministicDismissInput,
  type DeterministicProposal,
  type DeterministicProposalsInput,
  type DeterministicProposalState,
  LearningError,
  type ProjectId,
  TelemetryExtractionCandidate,
  type TelemetryExtractionForm,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { proposalTitle } from "./drafts.ts";
import * as Targets from "./targets.ts";

/** A candidate the weekly review proposes: most occurrences identical, in at least three threads. */
const MIN_DETERMINISTIC_RATIO = 0.8;
const MIN_THREADS = 3;
/** The most proposals a project gets in one week. */
const WEEKLY_LIMIT = 5;

interface Row {
  readonly id: number;
  readonly project_id: ProjectId;
  readonly candidate_id: string;
  readonly form: TelemetryExtractionForm;
  readonly candidate: string;
  readonly estimated_tokens: number;
  readonly window_from: string;
  readonly state: DeterministicProposalState;
  readonly draft: string | null;
  readonly waiting_reason: string | null;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly dismiss_reason: string | null;
  readonly created_at: string;
}

const CandidateJson = Schema.fromJsonString(TelemetryExtractionCandidate);
const DraftJson = Schema.fromJsonString(DeterministicDraft);
const decodeCandidate = Schema.decodeUnknownEffect(CandidateJson);
const encodeCandidate = Schema.encodeEffect(CandidateJson);
const decodeDraft = Schema.decodeUnknownEffect(DraftJson);
const encodeDraft = Schema.encodeEffect(DraftJson);

/** A proposal's latest row for its candidate, as the choice reads it. */
interface Previous {
  readonly state: DeterministicProposalState;
  readonly estimatedTokens: number;
}

/**
 * The candidates to propose, costliest first, at most `room`: those with a deterministic ratio of
 * at least 0.8 in at least three threads that were never proposed, or whose latest proposal was
 * dismissed and that now cost at least twice what they did then.
 */
const choose = (
  candidates: ReadonlyArray<TelemetryExtractionCandidate>,
  previous: ReadonlyMap<string, Previous>,
  room: number,
) =>
  candidates
    .filter((candidate) => {
      if (candidate.deterministicRatio < MIN_DETERMINISTIC_RATIO) return false;
      if (candidate.threads < MIN_THREADS) return false;
      const last = previous.get(candidate.id);
      return (
        last === undefined ||
        (last.state === "dismissed" &&
          candidate.estimatedTokens >= 2 * Math.max(1, last.estimatedTokens))
      );
    })
    .toSorted((a, b) => b.estimatedTokens - a.estimatedTokens)
    .slice(0, Math.max(0, room));

/**
 * The weekly review of repeated work: proposals made from telemetry's extraction candidates, each
 * with a draft in its form's target, which a person accepts or dismisses. Every change to a
 * proposal and its draft runs under one lock, so the sweep drafting a proposal and a person
 * deciding it never interleave.
 */
export class ProposalStore extends Context.Service<
  ProposalStore,
  {
    /** A project's proposals, newest first, at most `DETERMINISTIC_PROPOSALS_LIMIT`. */
    readonly list: (
      input: DeterministicProposalsInput,
    ) => Effect.Effect<ReadonlyArray<DeterministicProposal>, LearningError>;
    /** A project's proposals decided in `[from, to)`, and those created before `to` and undecided. */
    readonly inRange: (input: {
      readonly projectId: ProjectId;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<ReadonlyArray<DeterministicProposal>, LearningError>;
    /** A person accepts a `pending` proposal: its draft is applied in its target, then recorded. */
    readonly accept: (id: number) => Effect.Effect<DeterministicProposal, LearningError>;
    /**
     * Dismisses a `waiting` or `pending` proposal with a reason, as `by` (`user` or `thread:<id>`),
     * and withdraws its draft where the target still holds it undecided.
     */
    readonly dismiss: (
      input: DeterministicDismissInput,
      by: string,
    ) => Effect.Effect<DeterministicProposal, LearningError>;
    /**
     * Records this week's proposals for a project from its candidates, as `waiting` until drafted,
     * and answers how many. The week's earlier proposals count against `WEEKLY_LIMIT`, so a week
     * run twice proposes nothing more. A dry run counts and writes nothing.
     */
    readonly propose: (input: {
      readonly projectId: ProjectId;
      readonly windowFrom: string;
      readonly candidates: ReadonlyArray<TelemetryExtractionCandidate>;
      readonly dryRun: boolean;
    }) => Effect.Effect<number, LearningError>;
    /**
     * Saves a draft for each `waiting` proposal of the projects named; one whose target is still
     * unavailable keeps waiting with the reason. A dry run counts and writes nothing.
     */
    readonly draftWaiting: (input: {
      readonly projectIds: ReadonlySet<ProjectId>;
      readonly dryRun: boolean;
    }) => Effect.Effect<{ readonly waiting: number; readonly drafted: number }, LearningError>;
    /** How many `waiting` and `pending` proposals each project has; a project with none is absent. */
    readonly undecided: Effect.Effect<ReadonlyMap<ProjectId, number>, LearningError>;
  }
>()("t3/plugins/learning/deterministic/ProposalStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const targets = yield* Targets.make;
  const lock = yield* Semaphore.make(1);

  const failed = (cause: SqlError.SqlError | Schema.SchemaError) =>
    Effect.logWarning("learning: deterministic proposals could not be read or written", {
      cause,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new LearningError({
            code: "io",
            message: "The deterministic proposals could not be read or written.",
          }),
        ),
      ),
    );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const read = (row: Row) =>
    Effect.gen(function* () {
      const candidate = yield* decodeCandidate(row.candidate);
      return {
        proposal: {
          id: row.id,
          projectId: row.project_id,
          candidateId: row.candidate_id,
          form: row.form,
          title: proposalTitle(candidate),
          steps: candidate.steps,
          threads: candidate.threads,
          occurrences: candidate.occurrences,
          deterministicRatio: candidate.deterministicRatio,
          estimatedTokens: row.estimated_tokens,
          example: candidate.example,
          windowFrom: row.window_from,
          state: row.state,
          draft: row.draft === null ? null : yield* decodeDraft(row.draft),
          waitingReason: row.waiting_reason,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
          dismissReason: row.dismiss_reason,
          createdAt: row.created_at,
        } satisfies DeterministicProposal,
        candidate,
      };
    });
  const toProposal = (row: Row) => Effect.map(read(row), ({ proposal }) => proposal);

  const existing = (id: number) =>
    sql<Row>`SELECT * FROM deterministic_proposals WHERE id = ${id}`.pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(new LearningError({ code: "not_found", message: `No proposal ${id}.` }))
          : Effect.succeed(row),
      ),
    );

  const list: ProposalStore["Service"]["list"] = ({ projectId, state }) =>
    sql<Row>`SELECT * FROM deterministic_proposals
      WHERE ${sql.and([
        sql`project_id = ${projectId}`,
        ...(state === undefined ? [] : [sql`state = ${state}`]),
      ])}
      ORDER BY id DESC
      LIMIT ${DETERMINISTIC_PROPOSALS_LIMIT}`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, toProposal)),
      Effect.catchTags({ SqlError: failed, SchemaError: failed }),
    );

  const inRange: ProposalStore["Service"]["inRange"] = ({ projectId, from, to }) =>
    sql<Row>`SELECT * FROM deterministic_proposals
      WHERE project_id = ${projectId}
        AND ((decided_at >= ${from} AND decided_at < ${to})
          OR (state IN ('waiting', 'pending') AND created_at < ${to}))
      ORDER BY id`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, toProposal)),
      Effect.catchTags({ SqlError: failed, SchemaError: failed }),
    );

  const accept: ProposalStore["Service"]["accept"] = (id) =>
    Effect.gen(function* () {
      const row = yield* existing(id);
      const { proposal } = yield* read(row);
      if (proposal.state !== "pending" || proposal.draft === null) {
        return yield* new LearningError({
          code: "invalid",
          message: `Proposal ${id} is ${proposal.state}; only a pending one is accepted.`,
        });
      }
      yield* targets.accept(proposal.projectId, proposal.draft);
      const at = yield* nowIso;
      const [moved] = yield* sql<Row>`UPDATE deterministic_proposals
        SET state = 'accepted', decided_by = 'user', decided_at = ${at}, updated_at = ${at}
        WHERE id = ${id} AND state = 'pending'
        RETURNING *`;
      return yield* toProposal(moved!);
    }).pipe(lock.withPermits(1), Effect.catchTags({ SqlError: failed, SchemaError: failed }));

  const dismiss: ProposalStore["Service"]["dismiss"] = ({ id, reason }, by) =>
    Effect.gen(function* () {
      const row = yield* existing(id);
      const { proposal } = yield* read(row);
      if (proposal.state !== "waiting" && proposal.state !== "pending") {
        return yield* new LearningError({
          code: "invalid",
          message: `Proposal ${id} is ${proposal.state}; only a waiting or pending one is dismissed.`,
        });
      }
      if (proposal.draft !== null) yield* targets.withdraw(proposal.projectId, proposal.draft, by);
      const at = yield* nowIso;
      const [moved] = yield* sql<Row>`UPDATE deterministic_proposals
        SET state = 'dismissed', decided_by = ${by}, decided_at = ${at},
          dismiss_reason = ${reason}, updated_at = ${at}
        WHERE id = ${id} AND state IN ('waiting', 'pending')
        RETURNING *`;
      return yield* toProposal(moved!);
    }).pipe(lock.withPermits(1), Effect.catchTags({ SqlError: failed, SchemaError: failed }));

  const propose: ProposalStore["Service"]["propose"] = ({
    projectId,
    windowFrom,
    candidates,
    dryRun,
  }) =>
    Effect.gen(function* () {
      // The latest proposal of each candidate, by id: a dismissed one returns once its cost doubles.
      const history = yield* sql<{
        readonly candidate_id: string;
        readonly state: DeterministicProposalState;
        readonly estimated_tokens: number;
      }>`SELECT candidate_id, state, estimated_tokens FROM deterministic_proposals
        WHERE project_id = ${projectId} ORDER BY id`;
      const previous = new Map(
        history.map((row) => [
          row.candidate_id,
          { state: row.state, estimatedTokens: row.estimated_tokens },
        ]),
      );
      const [made] = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM deterministic_proposals
        WHERE project_id = ${projectId} AND window_from = ${windowFrom}`;
      const chosen = choose(candidates, previous, WEEKLY_LIMIT - (made?.count ?? 0));
      if (dryRun) return chosen.length;
      const at = yield* nowIso;
      for (const candidate of chosen) {
        yield* sql`INSERT INTO deterministic_proposals ${sql.insert({
          project_id: projectId,
          candidate_id: candidate.id,
          form: candidate.form,
          candidate: yield* encodeCandidate(candidate),
          estimated_tokens: candidate.estimatedTokens,
          window_from: windowFrom,
          state: "waiting",
          draft: null,
          waiting_reason: "The draft has not been saved yet.",
          decided_by: null,
          decided_at: null,
          dismiss_reason: null,
          created_at: at,
          updated_at: at,
        })} ON CONFLICT (project_id, candidate_id, window_from) DO NOTHING`;
      }
      return chosen.length;
    }).pipe(lock.withPermits(1), Effect.catchTags({ SqlError: failed, SchemaError: failed }));

  /** Drafts one waiting proposal, unless a person decided it since it was read. */
  const draftOne = (id: number) =>
    Effect.gen(function* () {
      const [row] = yield* sql<Row>`SELECT * FROM deterministic_proposals
        WHERE id = ${id} AND state = 'waiting'`;
      if (row === undefined) return false;
      const { candidate } = yield* read(row);
      const result = yield* targets.draft({
        id: row.id,
        projectId: row.project_id,
        candidate,
        windowFrom: row.window_from,
      });
      const at = yield* nowIso;
      if (result._tag === "waiting") {
        // Every tick tries again; only a new reason is written.
        if (result.reason !== row.waiting_reason) {
          yield* sql`UPDATE deterministic_proposals
            SET waiting_reason = ${result.reason}, updated_at = ${at} WHERE id = ${id}`;
        }
        return false;
      }
      yield* sql`UPDATE deterministic_proposals
        SET state = 'pending', draft = ${yield* encodeDraft(result.draft)},
          waiting_reason = NULL, updated_at = ${at}
        WHERE id = ${id}`;
      return true;
    }).pipe(lock.withPermits(1));

  const draftWaiting: ProposalStore["Service"]["draftWaiting"] = ({ projectIds, dryRun }) =>
    Effect.gen(function* () {
      const rows = (yield* sql<{ readonly id: number; readonly project_id: ProjectId }>`
        SELECT id, project_id FROM deterministic_proposals WHERE state = 'waiting' ORDER BY id`).filter(
        (row) => projectIds.has(row.project_id),
      );
      if (dryRun) return { waiting: rows.length, drafted: 0 };
      let drafted = 0;
      for (const row of rows) if (yield* draftOne(row.id)) drafted += 1;
      return { waiting: rows.length, drafted };
    }).pipe(Effect.catchTags({ SqlError: failed, SchemaError: failed }));

  const undecided: ProposalStore["Service"]["undecided"] = sql<{
    readonly project_id: ProjectId;
    readonly count: number;
  }>`SELECT project_id, count(*) AS count FROM deterministic_proposals
    WHERE state IN ('waiting', 'pending') GROUP BY project_id`.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.project_id, row.count]))),
    Effect.catchTags({ SqlError: failed }),
  );

  return ProposalStore.of({ list, inRange, accept, dismiss, propose, draftWaiting, undecided });
});

export const layer = Layer.effect(ProposalStore, make);

import { assert, it } from "@effect/vitest";
import { ThreadId, type ReviewVerdictError, type ReviewVerdictInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as CorrectionStore from "../learning/CorrectionStore.ts";
import {
  approve,
  foreign,
  harness,
  nobody,
  other,
  projectId,
  ready,
  reviewed,
  reviewer,
  sendBack,
  stale,
  withoutMode,
} from "./testkit.ts";

const refusal = (effect: Effect.Effect<unknown, ReviewVerdictError>) =>
  effect.pipe(Effect.andThen(Effect.die("expected a refusal")), Effect.flip);

it.effect("records a correction carrying the declared mode, then the verdict pointing at it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, review, corrections, verdictCount, correctionCount } = yield* harness;
      const result = yield* record(reviewer, sendBack);
      assert.isNumber(result.correctionId);
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 1);

      const correction = yield* corrections.get(result.correctionId!);
      assert.strictEqual(correction.failureKind, "review_verdict");
      assert.strictEqual(correction.declaredMode, "missing_verification");
      assert.strictEqual(correction.threadId, reviewed);
      assert.strictEqual(correction.projectId, projectId);
      assert.strictEqual(correction.description, sendBack.summary);
      assert.strictEqual(correction.sourceKey, `verdict:${result.verdictId}`);

      const rows = yield* review<{
        id: string;
        project_id: string;
        reviewed_thread_id: string;
        reviewer_thread_id: string;
        checkpoint_id: string;
        outcome: string;
        failure_mode: string | null;
        summary: string;
        correction_id: number | null;
        created_at: string;
        invalidated_at: string | null;
      }>`SELECT * FROM review_verdicts`;
      assert.deepEqual(rows, [
        {
          id: result.verdictId,
          project_id: projectId,
          reviewed_thread_id: reviewed,
          reviewer_thread_id: reviewer,
          checkpoint_id: ready,
          outcome: "changes_requested",
          failure_mode: "missing_verification",
          summary: sendBack.summary,
          correction_id: result.correctionId,
          created_at: rows[0]!.created_at,
          invalidated_at: null,
        },
      ]);
    }),
  ),
);

it.effect("answers a repeated identical call with the stored verdict and adds nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, verdictCount, correctionCount } = yield* harness;
      const first = yield* record(reviewer, sendBack);
      const second = yield* record(reviewer, sendBack);
      assert.deepEqual(second, first);
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 1);
    }),
  ),
);

it.effect("finishes a write that stopped after its correction only for the same verdict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, review, corrections, verdictCount, correctionCount } = yield* harness;
      const first = yield* record(reviewer, sendBack);
      // The process stopped after the correction and before the row.
      yield* review`DELETE FROM review_verdicts`;
      for (const changed of [{ ...sendBack, failureMode: "defect" as const }, approve]) {
        const refused = yield* refusal(record(reviewer, changed));
        assert.strictEqual(refused.code, "conflict");
        assert.strictEqual(refused.message, "This thread already reviewed this checkpoint");
      }
      assert.strictEqual(yield* verdictCount, 0);
      assert.strictEqual(yield* correctionCount, 1);
      const stored = yield* corrections.findBySourceKey(
        "review_verdict",
        `verdict:${first.verdictId}`,
      );
      assert.strictEqual(stored?.id, first.correctionId);
      assert.strictEqual(stored?.declaredMode, "missing_verification");

      const retried = yield* record(reviewer, sendBack);
      assert.deepEqual(retried, first);
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 1);
    }),
  ),
);

it.effect("stores an approval without a correction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, list, verdictCount, correctionCount } = yield* harness;
      const result = yield* record(reviewer, approve);
      assert.strictEqual(result.correctionId, null);
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 0);
      const [verdict] = yield* list({ threadId: reviewed });
      assert.strictEqual(verdict?.outcome, "approve");
      assert.strictEqual(verdict?.failureMode, null);
      assert.strictEqual(verdict?.correctionId, null);
      assert.strictEqual(verdict?.invalidatedAt, null);
    }),
  ),
);

it.effect("refuses what the ticket names, each with its message, and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, verdictCount, correctionCount } = yield* harness;
      const cases: ReadonlyArray<
        readonly [by: ThreadId, input: ReviewVerdictInput, code: string, message: string]
      > = [
        [reviewer, withoutMode, "invalid", "changes_requested needs a failureMode"],
        [
          reviewer,
          { ...approve, failureMode: "defect" },
          "invalid",
          "approve cannot carry a failureMode",
        ],
        [reviewed, sendBack, "invalid", "A thread cannot review its own work"],
        [
          reviewer,
          { ...sendBack, threadId: reviewed, checkpointId: foreign },
          "invalid",
          "Checkpoint checkpoint:of-other is not a ready checkpoint of thread thread:reviewed",
        ],
        [
          reviewer,
          { ...sendBack, checkpointId: stale },
          "invalid",
          "Checkpoint checkpoint:stale is not a ready checkpoint of thread thread:reviewed",
        ],
        [
          reviewer,
          { ...sendBack, threadId: nobody },
          "not_found",
          "Thread thread:nobody was not found.",
        ],
      ];
      for (const [by, input, code, message] of cases) {
        const refused = yield* refusal(record(by, input));
        assert.strictEqual(refused.code, code);
        assert.strictEqual(refused.message, message);
      }
      assert.strictEqual(yield* verdictCount, 0);
      assert.strictEqual(yield* correctionCount, 0);
    }),
  ),
);

const convention = (summary: string) =>
  ({ ...sendBack, failureMode: "convention", summary }) satisfies ReviewVerdictInput;

it.effect("stores a convention verdict that names a rung, as written", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, list, corrections, verdictCount } = yield* harness;
      // One verdict per reviewer and checkpoint, so each summary comes from its own reviewer.
      const summaries = [
        "rung:dependency adds a package for three lines",
        "rung:one_line. A loop does what a map does.",
        "rung:needed: nothing calls it",
      ];
      for (const [index, summary] of summaries.entries()) {
        const result = yield* record(
          ThreadId.make(`thread:reviewer-${index}`),
          convention(summary),
        );
        const correction = yield* corrections.get(result.correctionId!);
        assert.strictEqual(correction.declaredMode, "convention");
      }
      assert.strictEqual(yield* verdictCount, summaries.length);
      assert.deepEqual(
        (yield* list({ threadId: reviewed })).map((verdict) => verdict.summary),
        summaries,
      );
    }),
  ),
);

it.effect("refuses a convention summary that names no known rung, and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, verdictCount, correctionCount } = yield* harness;
      const rungs = "needed, existing, platform, dependency, one_line, minimum";
      for (const [named, summary] of [
        ["bogus", "rung:bogus"],
        ["", "rung:"],
        ["Dependency", "rung:Dependency, three lines"],
        ["one-line", "rung:one-line is the rung"],
      ] as const) {
        const refused = yield* refusal(record(reviewer, convention(summary)));
        assert.strictEqual(refused.code, "invalid");
        assert.strictEqual(refused.message, `Unknown rung "${named}". Rungs: ${rungs}.`);
      }
      assert.strictEqual(yield* verdictCount, 0);
      assert.strictEqual(yield* correctionCount, 0);
    }),
  ),
);

it.effect("answers the retry of a verdict stored before the ladder with the stored result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, review, verdictCount } = yield* harness;
      const stored = convention("rung:bogus");
      // A free-form summary that was valid when it was stored.
      const first = yield* record(reviewer, convention("Breaks the naming convention."));
      yield* review`UPDATE review_verdicts SET summary = ${stored.summary}`;

      assert.deepEqual(yield* record(reviewer, stored), first);
      // Only the same payload settles; any other is the usual conflict, not a rung refusal.
      const refused = yield* refusal(record(reviewer, convention("rung:bogus again")));
      assert.strictEqual(refused.code, "conflict");
      assert.strictEqual(yield* verdictCount, 1);
    }),
  ),
);

it.effect("leaves a summary alone unless it is a convention one starting with rung:", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, verdictCount } = yield* harness;
      const cases: ReadonlyArray<readonly [name: string, input: ReviewVerdictInput]> = [
        ["plain", convention("It breaks the naming convention.")],
        ["rung later in the text", convention("Breaks the ladder at rung:bogus.")],
        ["another mode", { ...sendBack, failureMode: "defect", summary: "rung:bogus" }],
        ["approval", { ...approve, summary: "rung:bogus" }],
      ];
      for (const [name, input] of cases) {
        yield* record(ThreadId.make(`thread:reviewer-${name}`), input);
      }
      assert.strictEqual(yield* verdictCount, cases.length);
    }),
  ),
);

it.effect("refuses a different verdict on a checkpoint the thread already reviewed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, list, verdictCount, correctionCount } = yield* harness;
      const first = yield* record(reviewer, sendBack);
      for (const changed of [
        { ...sendBack, failureMode: "defect" as const },
        { ...sendBack, summary: "Different words." },
        approve,
      ]) {
        const refused = yield* refusal(record(reviewer, changed));
        assert.strictEqual(refused.code, "conflict");
        assert.strictEqual(refused.message, "This thread already reviewed this checkpoint");
      }
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 1);
      assert.deepEqual(
        (yield* list({ threadId: reviewed })).map((verdict) => verdict.id),
        [first.verdictId],
      );
    }),
  ),
);

it.effect(
  "lets another reviewer judge the same checkpoint, and lists only the reviewed thread's",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { record, list, correctionCount } = yield* harness;
        yield* record(reviewer, sendBack);
        yield* record(other, approve);
        // A verdict on `other`'s own checkpoint, by the first reviewer.
        yield* record(reviewer, { ...sendBack, threadId: other, checkpointId: foreign });
        assert.strictEqual(yield* correctionCount, 2);
        assert.sameMembers(
          (yield* list({ threadId: reviewed })).map((verdict) => verdict.reviewerThreadId),
          [reviewer, other],
        );
        assert.strictEqual((yield* list({ threadId: other })).length, 1);
      }),
    ),
);

it.effect("lists a project's verdicts in [from, to), oldest first with ties by id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, review } = yield* harness;
      const give = (id: string, project: string, createdAt: string) =>
        review`INSERT INTO review_verdicts
          (id, project_id, reviewed_thread_id, reviewer_thread_id, checkpoint_id, outcome, summary,
           created_at)
          VALUES (${id}, ${project}, ${reviewed}, ${reviewer}, ${ready}, 'approve', 'Fine.',
           ${createdAt})`;
      yield* give("before", projectId, "2026-09-30T23:59:59.999Z");
      yield* give("later", projectId, "2026-10-02T00:00:00.000Z");
      yield* give("earlier-tied", projectId, "2026-10-02T00:00:00.000Z");
      yield* give("at-from", projectId, "2026-10-01T00:00:00.000Z");
      yield* give("at-to", projectId, "2026-10-08T00:00:00.000Z");
      yield* give("elsewhere", "project:elsewhere", "2026-10-03T00:00:00.000Z");

      const window = yield* store.listWindow({
        projectId,
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-08T00:00:00.000Z",
      });
      assert.deepEqual(
        window.map((verdict) => verdict.id),
        ["at-from", "earlier-tied", "later"],
      );
      // The same rows `list` reads for the thread, in the same shape.
      const ofThread = yield* store.list({ threadId: reviewed });
      assert.deepEqual(
        window,
        ofThread.filter((verdict) => window.some((inside) => inside.id === verdict.id)),
      );
      assert.deepEqual(
        yield* store.listWindow({
          projectId,
          from: "2026-10-09T00:00:00.000Z",
          to: "2026-10-10T00:00:00.000Z",
        }),
        [],
      );
    }),
  ),
);

/**
 * A learning store that takes turns with other fibers, as two requests on a busy server do. Both
 * callers get past the leftover check before either writes, and the first one to write a
 * correction stalls before its row, so the other reaches the insert first. Without `record`'s
 * lock, that other call's verdict would point at the first call's correction.
 */
const interleaved = (corrections: CorrectionStore.CorrectionStore["Service"]) =>
  Effect.gen(function* () {
    const writes = yield* Ref.make(0);
    return CorrectionStore.CorrectionStore.of({
      ...corrections,
      findBySourceKey: (failureKind, sourceKey) =>
        corrections.findBySourceKey(failureKind, sourceKey).pipe(Effect.tap(() => Effect.yieldNow)),
      record: (input) =>
        corrections.record(input).pipe(
          Effect.tap(() =>
            Effect.flatMap(
              Ref.getAndUpdate(writes, (count) => count + 1),
              (earlier) => (earlier === 0 ? Effect.yieldNow : Effect.void),
            ),
          ),
        ),
    });
  });

it.effect("keeps one verdict and the correction it declared when conflicting calls overlap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, review, corrections, verdictCount, correctionCount } = yield* harness;
      const overlapping = yield* interleaved(corrections);
      const call = (input: ReviewVerdictInput) =>
        store
          .record(reviewer, input)
          .pipe(Effect.provideService(CorrectionStore.CorrectionStore, overlapping), Effect.result);
      const outcomes = yield* Effect.all(
        [call(sendBack), call({ ...sendBack, failureMode: "defect" })],
        { concurrency: "unbounded" },
      );

      // One call wins and the other is refused, whichever of them it was.
      assert.deepEqual(
        outcomes.flatMap((outcome) => (outcome._tag === "Failure" ? [outcome.failure.code] : [])),
        ["conflict"],
      );
      assert.strictEqual(yield* verdictCount, 1);
      assert.strictEqual(yield* correctionCount, 1);
      const [verdict] = yield* review<{
        failure_mode: string;
        correction_id: number;
      }>`SELECT failure_mode, correction_id FROM review_verdicts`;
      const correction = yield* corrections.get(verdict!.correction_id);
      assert.strictEqual(verdict!.failure_mode, correction.declaredMode);
    }),
  ),
);

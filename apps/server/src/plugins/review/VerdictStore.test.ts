import { assert, it } from "@effect/vitest";
import type { ReviewVerdictError, ReviewVerdictInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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

it.effect("finds the same correction when a retry follows a verdict row that never landed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { record, review, verdictCount, correctionCount } = yield* harness;
      const first = yield* record(reviewer, sendBack);
      // The process stopped after the correction and before the row.
      yield* review`DELETE FROM review_verdicts`;
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

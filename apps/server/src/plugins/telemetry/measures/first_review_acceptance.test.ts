import { assert, it } from "@effect/vitest";
import { CheckpointId, ProjectId, type ReviewVerdict, ThreadId } from "@t3tools/contracts";
import { BEFORE, FROM, input, INSIDE, TO } from "./fixtures.ts";
import { firstReviewAcceptance } from "./first_review_acceptance.ts";

const LATER = "2026-10-03T00:00:00.000Z";

let sequence = 0;
const verdict = (
  thread: string,
  outcome: ReviewVerdict["outcome"],
  createdAt: string,
  overrides: Partial<ReviewVerdict> = {},
): ReviewVerdict => {
  sequence += 1;
  return {
    id: `verdict:${sequence}`,
    projectId: ProjectId.make("project:1"),
    reviewedThreadId: ThreadId.make(thread),
    reviewerThreadId: ThreadId.make("thread:reviewer"),
    checkpointId: CheckpointId.make(`checkpoint:${sequence}`),
    outcome,
    failureMode: outcome === "approve" ? null : "defect",
    summary: "Reviewed.",
    correctionId: null,
    createdAt,
    invalidatedAt: null,
    ...overrides,
  };
};

it("is the share of the window's reviewed threads whose first verdict approved", () => {
  const result = firstReviewAcceptance(
    input({
      verdicts: [
        verdict("thread:1", "approve", INSIDE),
        verdict("thread:2", "changes_requested", INSIDE),
        verdict("thread:3", "approve", LATER),
        verdict("thread:4", "approve", LATER),
        // Reviewed at the window's end, which the window excludes.
        verdict("thread:5", "changes_requested", TO),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 0.75, 4]);
});

it("is unavailable in an empty window, and while the review plugin is off", () => {
  const empty = firstReviewAcceptance(input());
  assert.deepEqual(
    [empty.state, empty.value, empty.sampleSize, empty.missingReason],
    ["unavailable", null, 0, "No thread had its first review in the window."],
  );
  const outside = firstReviewAcceptance(
    input({
      verdicts: [verdict("thread:1", "approve", BEFORE), verdict("thread:2", "approve", TO)],
    }),
  );
  assert.strictEqual(outside.state, "unavailable");

  const off = firstReviewAcceptance(input({ verdicts: undefined }));
  assert.deepEqual(
    [off.state, off.value, off.sampleSize, off.missingReason],
    ["unavailable", null, 0, "Review verdicts come from the review plugin, which is not running."],
  );
});

it("counts a thread reviewed twice by its first verdict, however the rows come", () => {
  const sentBack = verdict("thread:1", "changes_requested", INSIDE);
  const approved = verdict("thread:1", "approve", LATER);
  for (const verdicts of [
    [sentBack, approved],
    [approved, sentBack],
  ]) {
    const result = firstReviewAcceptance(input({ verdicts }));
    assert.deepEqual([result.value, result.sampleSize], [0, 1]);
  }
});

it("breaks a tie in time by verdict id", () => {
  const first = verdict("thread:1", "approve", INSIDE, { id: "a" });
  const second = verdict("thread:1", "changes_requested", INSIDE, { id: "b" });
  const result = firstReviewAcceptance(input({ verdicts: [second, first] }));
  assert.deepEqual([result.value, result.sampleSize], [1, 1]);
});

it("leaves out a thread first reviewed before the window, whatever it was given inside it", () => {
  const result = firstReviewAcceptance(
    input({
      verdicts: [
        verdict("thread:1", "changes_requested", BEFORE),
        verdict("thread:1", "approve", INSIDE),
        verdict("thread:2", "changes_requested", FROM),
      ],
    }),
  );
  // Only thread:2, whose first verdict is at the window's start, which the window includes.
  assert.deepEqual([result.value, result.sampleSize], [0, 1]);
});

it("counts a first verdict that was invalidated, since it was given", () => {
  const result = firstReviewAcceptance(
    input({ verdicts: [verdict("thread:1", "approve", INSIDE, { invalidatedAt: LATER })] }),
  );
  assert.deepEqual([result.value, result.sampleSize], [1, 1]);
});

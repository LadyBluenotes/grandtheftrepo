import { verdictFields } from "../fields.ts";
import { inWindow, type Measure, ok, type Spec, unavailable } from "./input.ts";

const spec = {
  measure: "first_review_acceptance",
  unit: "ratio",
  direction: "higher_is_better",
  provenance: [
    "review.verdict.id",
    "review.verdict.reviewedThreadId",
    "review.verdict.createdAt",
    "review.verdict.outcome",
  ],
} as const satisfies Spec;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Of the threads whose first verdict fell in the window, the share whose first verdict approved.
 * A thread's first verdict is its oldest, ties by id, wherever that falls: one first reviewed
 * before the window is not counted for a later verdict in it. A later verdict on a thread never
 * changes its first, and neither does `invalidatedAt`: the verdict was given.
 */
export const firstReviewAcceptance: Measure = (input) => {
  if (input.verdicts === undefined) {
    return unavailable(spec, "Review verdicts come from the review plugin, which is not running.");
  }
  const oldestFirst = input.verdicts
    .map(verdictFields)
    .sort(
      (a, b) =>
        compare(a["review.verdict.createdAt"], b["review.verdict.createdAt"]) ||
        compare(a["review.verdict.id"], b["review.verdict.id"]),
    );
  const seen = new Set<string>();
  const reviewed = oldestFirst.filter((verdict) => {
    const thread = verdict["review.verdict.reviewedThreadId"];
    if (seen.has(thread)) return false;
    seen.add(thread);
    return inWindow(input, verdict["review.verdict.createdAt"]);
  });
  if (reviewed.length === 0) {
    return unavailable(spec, "No thread had its first review in the window.");
  }
  const approved = reviewed.filter((verdict) => verdict["review.verdict.outcome"] === "approve");
  return ok(spec, approved.length / reviewed.length, reviewed.length);
};

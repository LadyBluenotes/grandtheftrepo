import { assert, it } from "@effect/vitest";
import { accepted, FROM, input, INSIDE, TO } from "./fixtures.ts";
import { timeToAcceptedOutcome } from "./time_to_accepted_outcome.ts";

const HOUR_LATER = "2026-10-01T01:00:00.000Z";

it("averages the seconds from creation to settlement over accepted outcomes", () => {
  const result = timeToAcceptedOutcome(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2", settled_at: HOUR_LATER })],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", (86_400 + 3600) / 2, 2]);
});

it("is unavailable in an empty window", () => {
  const result = timeToAcceptedOutcome(input({ threads: [accepted({ settled_at: TO })] }));
  assert.deepEqual(
    [result.state, result.missingReason],
    ["unavailable", "No accepted outcome in the window."],
  );
});

it("counts a reopened thread only once it settles again, and a sweep's settlement only after a merge", () => {
  const result = timeToAcceptedOutcome(
    input({
      threads: [
        // Settled by hand, then reopened: not accepted.
        accepted({ thread_id: "reopened", unsettled_at: "2026-10-03T00:00:00.000Z" }),
        // Reopened, then settled again: measured to the latest settlement.
        accepted({ thread_id: "resettled", settled_at: INSIDE, unsettled_at: HOUR_LATER }),
        // Settled by the inactivity sweep with nothing merged: not accepted.
        accepted({ thread_id: "swept", settled_by_sweep: 1 }),
        // Settled by the sweep after its pull request merged: accepted.
        accepted({ thread_id: "merged", settled_by_sweep: 1, pull_request_merged_at: FROM }),
        // A child task is part of its parent's outcome.
        accepted({ thread_id: "child", parent_thread_id: "merged" }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [86_400, 2]);
});

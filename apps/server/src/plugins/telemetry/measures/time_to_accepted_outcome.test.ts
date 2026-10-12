import { assert, it } from "@effect/vitest";
import { accepted, BEFORE, FROM, input, INSIDE, run, TO } from "./fixtures.ts";
import { timeToAcceptedOutcome } from "./time_to_accepted_outcome.ts";

const HOUR_LATER = "2026-10-01T01:00:00.000Z";
const REOPENED = "2026-10-03T00:00:00.000Z";

it("averages the seconds from first turn to settlement over accepted outcomes", () => {
  const result = timeToAcceptedOutcome(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2", settled_at: HOUR_LATER })],
      runs: [
        run({ started_at: FROM }),
        // A later run does not move the first turn.
        run({ run_id: "run:2", started_at: HOUR_LATER }),
        run({ run_id: "run:3", thread_id: "thread:2", started_at: FROM }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", (86_400 + 3600) / 2, 2]);
});

it("starts at the first run, not at the thread's creation, and leaves out an outcome with no run", () => {
  const result = timeToAcceptedOutcome(
    input({
      threads: [accepted({ created_at: BEFORE }), accepted({ thread_id: "never-ran" })],
      runs: [
        run({ started_at: FROM }),
        // Queued and never started.
        run({ run_id: "run:queued", thread_id: "never-ran", started_at: null }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 86_400, 1]);
  assert.match(result.missingReason ?? "", /^1 of 2 accepted outcomes were left out/);

  const none = timeToAcceptedOutcome(input({ threads: [accepted()] }));
  assert.deepEqual(
    [none.state, none.missingReason],
    ["unavailable", "No accepted outcome in the window has a run that started."],
  );
});

it("is unavailable in an empty window", () => {
  const result = timeToAcceptedOutcome(input({ threads: [accepted({ settled_at: TO })] }));
  assert.deepEqual(
    [result.state, result.missingReason],
    ["unavailable", "No accepted outcome in the window."],
  );
});

it("counts a reopened thread only once it settles again, merged or not, and a sweep's settlement only after a merge", () => {
  const threads = [
    // Settled by hand, then reopened: not accepted.
    accepted({ thread_id: "reopened", unsettled_at: REOPENED }),
    // Its pull request merged and it settled, then it was reopened: not accepted either.
    accepted({
      thread_id: "merged-reopened",
      pull_request_merged_at: FROM,
      unsettled_at: REOPENED,
    }),
    // Reopened, then settled again: measured to the latest settlement.
    accepted({ thread_id: "resettled", settled_at: INSIDE, unsettled_at: HOUR_LATER }),
    // Settled by the inactivity sweep with nothing merged: not accepted.
    accepted({ thread_id: "swept", settled_by_sweep: 1 }),
    // Settled by the sweep after its pull request merged: accepted.
    accepted({ thread_id: "merged", settled_by_sweep: 1, pull_request_merged_at: FROM }),
    // A child task is part of its parent's outcome.
    accepted({ thread_id: "child", parent_thread_id: "merged" }),
  ];
  const result = timeToAcceptedOutcome(
    input({
      threads,
      runs: threads.map((thread) =>
        run({ run_id: `run:${thread.thread_id}`, thread_id: thread.thread_id, started_at: FROM }),
      ),
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [86_400, 2]);
});

import { assert, it } from "@effect/vitest";
import { delegationOverhead } from "./delegation_overhead.ts";
import { accepted, BEFORE, input, run, thread, usage } from "./fixtures.ts";

const child = thread({ thread_id: "child:1", parent_thread_id: "thread:1" });
const childRun = run({ run_id: "run:child", thread_id: "child:1" });

it("sums child task tokens per accepted outcome that delegated", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), child],
      runs: [run(), childRun],
      turnUsage: [
        usage({ thread_id: "child:1", run_id: "run:child" }),
        usage({ thread_id: "child:1", run_id: "run:child", input_tokens: 500, output_tokens: 50 }),
        // The parent's own turns are not overhead.
        usage(),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1650, 1]);
});

it("is unavailable in an empty window, and when no accepted outcome delegated", () => {
  assert.strictEqual(delegationOverhead(input()).state, "unavailable");
  assert.strictEqual(
    delegationOverhead(input({ threads: [accepted()], runs: [run()], turnUsage: [usage()] }))
      .missingReason,
    "No accepted outcome in the window delegated a child task.",
  );
});

it("counts only outcomes that delegated, and leaves out a child turn missing a count", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2" }), child],
      runs: [childRun],
      turnUsage: [
        usage({ thread_id: "child:1", run_id: "run:child" }),
        usage({ thread_id: "child:1", run_id: "run:child", output_tokens: null }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [1100, 1]);
  assert.match(result.missingReason ?? "", /^1 of 2 child turns/);
});

it("counts only child runs that started in the window, as cost does, and no turn without a run", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), child],
      runs: [
        childRun,
        run({ run_id: "run:child-before", thread_id: "child:1", started_at: BEFORE }),
      ],
      turnUsage: [
        usage({ thread_id: "child:1", run_id: "run:child" }),
        usage({ thread_id: "child:1", run_id: "run:child-before" }),
        usage({ thread_id: "child:1", run_id: null }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize, result.missingReason], [1100, 1, null]);

  const before = delegationOverhead(
    input({
      threads: [accepted(), child],
      runs: [run({ run_id: "run:child-before", thread_id: "child:1", started_at: BEFORE })],
      turnUsage: [usage({ thread_id: "child:1", run_id: "run:child-before" })],
    }),
  );
  assert.deepEqual(
    [before.state, before.missingReason],
    [
      "unavailable",
      "No child task of an accepted outcome reported token usage for a run in the window.",
    ],
  );
});

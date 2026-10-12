import { assert, it } from "@effect/vitest";
import { delegationOverhead } from "./delegation_overhead.ts";
import { accepted, BEFORE, input, run, thread, usage } from "./fixtures.ts";

const child = thread({ thread_id: "child:1", parent_thread_id: "thread:1" });
const childRun = run({ run_id: "run:child", thread_id: "child:1" });

it("sums child task tokens per accepted outcome", () => {
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

it("is unavailable when no outcome was accepted in the window", () => {
  assert.strictEqual(
    delegationOverhead(input()).missingReason,
    "No accepted outcome in the window.",
  );
  assert.strictEqual(
    delegationOverhead(input({ threads: [thread()], runs: [run()], turnUsage: [usage()] })).state,
    "unavailable",
  );
});

it("divides by every accepted outcome, delegating or not", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2" }), child],
      runs: [childRun],
      turnUsage: [
        usage({ thread_id: "child:1", run_id: "run:child", input_tokens: 900, output_tokens: 100 }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 500, 2]);
});

it("is a real zero when no accepted outcome delegated", () => {
  const result = delegationOverhead(
    input({ threads: [accepted()], runs: [run()], turnUsage: [usage()] }),
  );
  assert.deepEqual(
    [result.state, result.value, result.sampleSize, result.missingReason],
    ["ok", 0, 1, null],
  );
});

it("leaves out a child turn missing a count, and is unavailable when every one is", () => {
  const some = delegationOverhead(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2" }), child],
      runs: [childRun],
      turnUsage: [
        usage({ thread_id: "child:1", run_id: "run:child" }),
        usage({ thread_id: "child:1", run_id: "run:child", output_tokens: null }),
      ],
    }),
  );
  assert.deepEqual([some.value, some.sampleSize], [550, 2]);
  assert.match(some.missingReason ?? "", /^1 of 2 child turns/);

  const none = delegationOverhead(
    input({
      threads: [accepted(), child],
      runs: [childRun],
      turnUsage: [usage({ thread_id: "child:1", run_id: "run:child", output_tokens: null })],
    }),
  );
  assert.deepEqual(
    [none.state, none.missingReason],
    [
      "unavailable",
      "No child task of an accepted outcome reported input and output token counts for a run in the window.",
    ],
  );
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

  // Child usage outside the window is no usage in it: a zero, not a gap.
  const before = delegationOverhead(
    input({
      threads: [accepted(), child],
      runs: [run({ run_id: "run:child-before", thread_id: "child:1", started_at: BEFORE })],
      turnUsage: [usage({ thread_id: "child:1", run_id: "run:child-before" })],
    }),
  );
  assert.deepEqual([before.state, before.value, before.sampleSize], ["ok", 0, 1]);
});

import { assert, it } from "@effect/vitest";
import { delegationOverhead } from "./delegation_overhead.ts";
import { accepted, input, thread, usage } from "./fixtures.ts";

const child = thread({ thread_id: "child:1", parent_thread_id: "thread:1" });

it("sums child task tokens per accepted outcome that delegated", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), child],
      turnUsage: [
        usage({ thread_id: "child:1" }),
        usage({ thread_id: "child:1", input_tokens: 500, output_tokens: 50 }),
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
    delegationOverhead(input({ threads: [accepted()], turnUsage: [usage()] })).missingReason,
    "No accepted outcome in the window delegated a child task.",
  );
});

it("counts only outcomes that delegated, and leaves out a child turn missing a count", () => {
  const result = delegationOverhead(
    input({
      threads: [accepted(), accepted({ thread_id: "thread:2" }), child],
      turnUsage: [
        usage({ thread_id: "child:1" }),
        usage({ thread_id: "child:1", output_tokens: null }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [1100, 1]);
  assert.match(result.missingReason ?? "", /^1 of 2 child turns/);
});

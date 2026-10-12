import { assert, it } from "@effect/vitest";
import { BEFORE, input, run } from "./fixtures.ts";
import { recoveryEfficiency } from "./recovery_efficiency.ts";

it("counts failed runs whose thread's next run completed, over failed runs", () => {
  const result = recoveryEfficiency(
    input({
      runs: [
        run({ status: "failed" }),
        run({ run_id: "run:2", ordinal: 2 }),
        // Failed with no retry after it.
        run({ run_id: "run:3", thread_id: "thread:2", status: "failed" }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1 / 2, 2]);
});

it("is unavailable in an empty window, and when no run in it failed", () => {
  assert.strictEqual(recoveryEfficiency(input()).state, "unavailable");
  assert.strictEqual(
    recoveryEfficiency(
      input({ runs: [run(), run({ run_id: "run:x", status: "failed", started_at: BEFORE })] }),
    ).missingReason,
    "No run in the window failed.",
  );
});

it("credits a recovery to the run just before it, not to an earlier failure", () => {
  const result = recoveryEfficiency(
    input({
      runs: [
        run({ ordinal: 1, status: "failed" }),
        run({ run_id: "run:2", ordinal: 2, status: "failed" }),
        run({ run_id: "run:3", ordinal: 3 }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [1 / 2, 2]);
});

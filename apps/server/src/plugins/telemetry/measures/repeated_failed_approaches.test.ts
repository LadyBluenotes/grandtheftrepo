import { assert, it } from "@effect/vitest";
import { call, edit, input, read, run } from "./fixtures.ts";
import { repeatedFailedApproaches } from "./repeated_failed_approaches.ts";

it("counts failed calls repeating an earlier failed call's tool and path, over failed calls", () => {
  const result = repeatedFailedApproaches(
    input({
      runs: [run()],
      toolCalls: [
        edit("src/a.ts", { status: "failed" }),
        read("src/a.ts"),
        edit("src/a.ts", { status: "failed" }),
        edit("src/b.ts", { status: "failed" }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1 / 3, 1]);
});

it("is unavailable in an empty window, and when nothing failed", () => {
  assert.strictEqual(repeatedFailedApproaches(input()).state, "unavailable");
  assert.strictEqual(
    repeatedFailedApproaches(input({ runs: [run()], toolCalls: [read("src/a.ts")] })).missingReason,
    "No tool call failed in the window.",
  );
});

it("does not repeat across runs, across tools, or without a path", () => {
  const command = { item_type: "command_execution", tool_name: null, path: null };
  const result = repeatedFailedApproaches(
    input({
      runs: [run(), run({ run_id: "run:2", ordinal: 2 })],
      toolCalls: [
        edit("src/a.ts", { status: "failed" }),
        edit("src/a.ts", { status: "failed", run_id: "run:2" }),
        read("src/a.ts", { status: "failed" }),
        call({ ...command, status: "failed" }),
        call({ ...command, status: "failed" }),
      ],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [0, 2]);
});

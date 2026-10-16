import { assert, it } from "@effect/vitest";
import { BEFORE, call, edit, input, read, run } from "./fixtures.ts";
import { repeatedReads } from "./repeated_reads.ts";

it("counts reads of a path the run already read, over all reads", () => {
  const result = repeatedReads(
    input({
      runs: [run(), run({ run_id: "run:2", ordinal: 2 })],
      toolCalls: [
        read("src/a.ts"),
        read("src/b.ts"),
        read("src/a.ts"),
        // A different run starts its own count.
        read("src/a.ts", { run_id: "run:2" }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1 / 4, 2]);
});

it("is unavailable in an empty window, and when no run in it read a file", () => {
  assert.strictEqual(repeatedReads(input()).state, "unavailable");
  const result = repeatedReads(
    input({
      runs: [run(), run({ run_id: "run:before", started_at: BEFORE })],
      toolCalls: [
        call({ item_type: "command_execution", tool_name: null, path: null }),
        // A search with a path is not a read, and neither is a read outside the window.
        call({ tool_name: "Grep", path: "src" }),
        read("src/a.ts", { run_id: "run:before" }),
      ],
    }),
  );
  assert.deepEqual(
    [result.state, result.missingReason],
    ["unavailable", "No run in the window read a file."],
  );
});

it("does not count a read after an edit of the same path as a repeat", () => {
  const result = repeatedReads(
    input({
      runs: [run()],
      toolCalls: [read("src/a.ts"), edit("src/a.ts"), read("src/a.ts"), edit("src/b.ts")],
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [0, 1]);
});

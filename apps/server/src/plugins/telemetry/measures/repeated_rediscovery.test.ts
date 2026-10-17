import { assert, it } from "@effect/vitest";
import { BEFORE, edit, input, read, run } from "./fixtures.ts";
import { repeatedRediscovery } from "./repeated_rediscovery.ts";

// The thread's first run, before the window, read src/a.ts.
const first = run({ run_id: "run:first", started_at: BEFORE });
const firstRead = read("src/a.ts", { run_id: "run:first" });
const later = run({ run_id: "run:later", ordinal: 2 });

it("counts paths a later run read that an earlier run of the thread already read", () => {
  const result = repeatedRediscovery(
    input({
      runs: [first, later],
      toolCalls: [
        firstRead,
        read("src/a.ts", { run_id: "run:later" }),
        read("src/a.ts", { run_id: "run:later" }),
        read("src/b.ts", { run_id: "run:later" }),
      ],
    }),
  );
  // a.ts counts once for the run: one rediscovery out of two paths.
  assert.deepEqual([result.state, result.value, result.sampleSize], ["ok", 1 / 2, 1]);
});

it("is unavailable in an empty window, and for a thread's first run", () => {
  assert.strictEqual(repeatedRediscovery(input()).state, "unavailable");
  const result = repeatedRediscovery(
    input({ runs: [run()], toolCalls: [read("src/a.ts"), read("src/a.ts")] }),
  );
  assert.deepEqual(
    [result.state, result.missingReason],
    ["unavailable", "No later run of a thread in the window read a file."],
  );
});

it("does not count a path edited since the earlier read", () => {
  const result = repeatedRediscovery(
    input({
      runs: [first, later],
      toolCalls: [
        firstRead,
        edit("src/a.ts", { run_id: "run:later" }),
        read("src/a.ts", { run_id: "run:later" }),
      ],
    }),
  );
  assert.deepEqual([result.state, result.value], ["ok", 0]);
});

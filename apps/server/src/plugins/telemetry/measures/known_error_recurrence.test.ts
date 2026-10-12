import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { knownErrorRecurrence } from "./known_error_recurrence.ts";

// Every input this measure would read exists here; only the adopted fixes are missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would supply it", () => {
  const result = knownErrorRecurrence(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /learning items \(#5\)/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(knownErrorRecurrence(input()).state, "unavailable");
});

it("never stands a zero in for the adopted fixes", () => {
  const result = knownErrorRecurrence(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});

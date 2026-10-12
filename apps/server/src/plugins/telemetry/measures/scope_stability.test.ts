import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { scopeStability } from "./scope_stability.ts";

// Every input this measure would read exists here; only the record of amendments is missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would record it", () => {
  const result = scopeStability(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /#28 adds that record/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(scopeStability(input()).state, "unavailable");
});

it("never stands a zero in for the amendments", () => {
  const result = scopeStability(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});

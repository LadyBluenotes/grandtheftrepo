import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { scopeStability } from "./scope_stability.ts";

// Every input this measure would read exists here; only the acceptance criteria are missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would supply it", () => {
  const result = scopeStability(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /tickets plugin \(#22\)/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(scopeStability(input()).state, "unavailable");
});

it("never stands a zero in for the acceptance criteria", () => {
  const result = scopeStability(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});

import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { supervisionBurden } from "./supervision_burden.ts";

// Every input this measure would read exists here; only the attention flags are missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would supply it", () => {
  const result = supervisionBurden(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /flag history is not kept yet \(#12\)/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(supervisionBurden(input()).state, "unavailable");
});

it("never stands a zero in for the attention flags", () => {
  const result = supervisionBurden(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});

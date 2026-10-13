import { assert, it } from "@effect/vitest";
import { accepted, input, read, run, usage } from "./fixtures.ts";
import { contextEfficiency } from "./context_efficiency.ts";

// Every input this measure would read exists here; only the routing tiers are missing.
const full = input({
  threads: [accepted()],
  runs: [run()],
  toolCalls: [read("src/a.ts")],
  turnUsage: [usage()],
});

it("is unavailable in a normal window, naming what would supply it", () => {
  const result = contextEfficiency(full);
  assert.strictEqual(result.state, "unavailable");
  assert.match(result.missingReason ?? "", /routing plugin .* #19/);
});

it("is unavailable in an empty window", () => {
  assert.strictEqual(contextEfficiency(input()).state, "unavailable");
});

it("never stands a zero in for the routing tiers", () => {
  const result = contextEfficiency(full);
  assert.deepEqual([result.value, result.sampleSize, result.provenance], [null, 0, []]);
});

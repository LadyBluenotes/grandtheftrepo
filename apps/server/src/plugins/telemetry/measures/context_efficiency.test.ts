import { assert, it } from "@effect/vitest";
import { BEFORE, input, run, usage } from "./fixtures.ts";
import { contextEfficiency } from "./context_efficiency.ts";

// Two runs in the window and one before it; `MeasureService` has already kept only the tier's.
const rows = {
  runs: [run(), run({ run_id: "run:2" }), run({ run_id: "run:old", started_at: BEFORE })],
  turnUsage: [
    usage({ output_tokens: 100 }),
    usage({ output_tokens: 300 }),
    usage({ run_id: "run:2", output_tokens: 800 }),
    usage({ run_id: "run:old", output_tokens: 10_000 }),
  ],
};

it("is output tokens per turn over the window's runs on the tier", () => {
  const result = contextEfficiency(input({ ...rows, tier: "standard" }));
  assert.deepEqual(
    [result.state, result.value, result.sampleSize, result.missingReason],
    ["ok", 400, 3, null],
  );
});

it("leaves out a turn without an output count, and says so", () => {
  const result = contextEfficiency(
    input({
      ...rows,
      turnUsage: [...rows.turnUsage, usage({ output_tokens: null })],
      tier: "standard",
    }),
  );
  assert.deepEqual([result.value, result.sampleSize], [400, 3]);
  assert.match(result.missingReason ?? "", /1 of 4 turns were left out/);
});

it("is unavailable without a tier, never a figure across tiers", () => {
  const result = contextEfficiency(input(rows));
  assert.deepEqual([result.state, result.value, result.sampleSize], ["unavailable", null, 0]);
  assert.match(result.missingReason ?? "", /per routing tier/);
});

it("is unavailable when no turn on the tier reported usage, never zero", () => {
  const result = contextEfficiency(input({ tier: "cheap" }));
  assert.deepEqual([result.state, result.value], ["unavailable", null]);
  assert.match(result.missingReason ?? "", /cheap tier's model/);
});

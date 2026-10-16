import { assert, it } from "@effect/vitest";
import { createOverrideRateTable, parseRateTable } from "../../../usage/usagePricing.ts";
import { costPerAcceptedOutcome } from "./cost_per_accepted_outcome.ts";
import { accepted, BEFORE, input, run, usage } from "./fixtures.ts";

const pricing = {
  rates: parseRateTable({
    "test-model": {
      input_cost_per_token: 0.000_001,
      output_cost_per_token: 0.000_01,
      cache_read_input_token_cost: 0.000_000_1,
    },
  }),
  overrides: createOverrideRateTable({}),
  aliases: new Map([["proxy-model", "test-model"]]),
};
// 600 uncached input, 400 cached input and 100 output tokens at the rates above.
const TURN_USD = 600 * 0.000_001 + 400 * 0.000_000_1 + 100 * 0.000_01;

it("prices every turn of the window's runs, per accepted outcome", () => {
  const result = costPerAcceptedOutcome(
    input({
      pricing,
      threads: [accepted(), accepted({ thread_id: "thread:2" })],
      runs: [run(), run({ run_id: "run:2", model: "proxy-model" })],
      turnUsage: [usage(), usage(), usage({ run_id: "run:2" })],
    }),
  );
  assert.strictEqual(result.state, "ok");
  assert.closeTo(result.value ?? 0, (3 * TURN_USD) / 2, 1e-12);
  assert.deepEqual([result.sampleSize, result.missingReason], [2, null]);
});

it("is unavailable in an empty window, and when no turn can be priced", () => {
  assert.strictEqual(costPerAcceptedOutcome(input({ pricing })).state, "unavailable");
  const unpriced = costPerAcceptedOutcome(
    input({
      pricing,
      threads: [accepted()],
      runs: [run({ model: "unknown-model" })],
      turnUsage: [usage()],
    }),
  );
  assert.strictEqual(unpriced.state, "unavailable");
  assert.match(unpriced.missingReason ?? "", /could be priced/);
});

it("leaves out turns it cannot price, says how many, and ignores runs outside the window", () => {
  const result = costPerAcceptedOutcome(
    input({
      pricing,
      threads: [accepted()],
      runs: [
        run(),
        run({ run_id: "run:unknown", model: "unknown-model" }),
        run({ run_id: "run:before", started_at: BEFORE }),
      ],
      turnUsage: [
        usage(),
        usage({ cached_input_tokens: null }),
        usage({ run_id: "run:unknown" }),
        usage({ run_id: "run:before" }),
      ],
    }),
  );
  assert.closeTo(result.value ?? 0, TURN_USD, 1e-12);
  assert.match(result.missingReason ?? "", /^2 of 3 turns/);
});

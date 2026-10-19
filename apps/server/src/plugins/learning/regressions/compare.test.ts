import { assert, it } from "@effect/vitest";
import type { TelemetryMeasure } from "@t3tools/contracts";
import { compare } from "./compare.ts";

const threshold = { relative: 0.2, minSample: 10 };

const measure = (
  value: number | null,
  fields: Partial<TelemetryMeasure> = {},
): TelemetryMeasure => ({
  measure: "context_efficiency",
  state: "ok",
  value,
  unit: "tokens",
  direction: "lower_is_better",
  sampleSize: 12,
  missingReason: null,
  provenance: [],
  ...fields,
});

it("a lower-is-better measure that rose past the threshold is a regression", () => {
  assert.strictEqual(
    compare(measure(1200), measure(1700), threshold),
    "context_efficiency 1200 → 1700 (+42%)",
  );
});

it("a higher-is-better measure that fell past the threshold is a regression, shown as a drop", () => {
  const ratio = {
    measure: "first_review_acceptance",
    unit: "ratio",
    direction: "higher_is_better",
  } as const;
  assert.strictEqual(
    compare(measure(0.6, ratio), measure(0.35, ratio), threshold),
    "first_review_acceptance 0.60 → 0.35 (-42%)",
  );
  // The same moves the other way are improvements.
  assert.isNull(compare(measure(0.35, ratio), measure(0.6, ratio), threshold));
  assert.isNull(compare(measure(1700), measure(1200), threshold));
});

it("worsening exactly at the threshold counts and just under it does not", () => {
  assert.strictEqual(
    compare(measure(100), measure(120), threshold),
    "context_efficiency 100 → 120 (+20%)",
  );
  assert.isNull(compare(measure(100), measure(119), threshold));
  assert.isNull(compare(measure(100), measure(110), threshold));
});

it("the windows cannot say when either is unavailable, too small, or starts from nothing", () => {
  const unavailable = { state: "unavailable", missingReason: "Not recorded." } as const;
  assert.isNull(compare(measure(null, unavailable), measure(1700), threshold));
  assert.isNull(compare(measure(1200), measure(null, unavailable), threshold));
  assert.isNull(compare(measure(1200, { sampleSize: 3 }), measure(1700), threshold));
  assert.isNull(compare(measure(1200), measure(1700, { sampleSize: 9 }), threshold));
  assert.isNull(compare(measure(0), measure(1700), threshold));
  assert.isNull(compare(measure(null), measure(1700), threshold));
  // Exactly the minimum sample is enough.
  assert.isNotNull(
    compare(measure(1200, { sampleSize: 10 }), measure(1700, { sampleSize: 10 }), threshold),
  );
});

it("whole numbers for tokens, seconds and counts; two decimals for ratios and dollars", () => {
  const cost = { measure: "cost_per_accepted_outcome", unit: "usd" } as const;
  assert.strictEqual(
    compare(measure(1.5, cost), measure(2.25, cost), threshold),
    "cost_per_accepted_outcome 1.50 → 2.25 (+50%)",
  );
  const time = { measure: "time_to_accepted_outcome", unit: "seconds" } as const;
  assert.strictEqual(
    compare(measure(600.4, time), measure(900.6, time), threshold),
    "time_to_accepted_outcome 600 → 901 (+50%)",
  );
  const count = { measure: "supervision_burden", unit: "count" } as const;
  assert.strictEqual(
    compare(measure(3, count), measure(4, count), threshold),
    "supervision_burden 3 → 4 (+33%)",
  );
});

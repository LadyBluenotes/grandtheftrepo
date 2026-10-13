import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type RoutingEntry,
  type RoutingTier,
  ThreadId,
} from "@t3tools/contracts";

import { adherence, type Observed, type Recommended } from "./adherence.ts";

const alpha: RoutingEntry = { providerInstanceId: ProviderInstanceId.make("alpha"), model: "a-3" };
const beta: RoutingEntry = { providerInstanceId: ProviderInstanceId.make("beta"), model: "b-1" };

const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };

const recommendation = (
  id: number,
  at = "2026-10-01T12:00:00.000Z",
  entry: RoutingEntry | null = alpha,
  tier: RoutingTier = "cheap",
): Recommended => ({ id, at, threadId: ThreadId.make(`thread-${id}`), tier, entry });

const matched = (recommendationId: number): Observed => ({
  recommendationId,
  detail: { recommendationId, observed: alpha, matched: true, flag: null },
});
const mismatched = (recommendationId: number, flag = `Thread ${recommendationId} drifted.`) => ({
  recommendationId,
  detail: { recommendationId, observed: beta, matched: false, flag } as const,
});

describe("adherence", () => {
  it("three matches and one mismatch at a minimum of four give 0.75 and name the mismatch", () => {
    const result = adherence(
      {
        recommended: [1, 2, 3, 4].map((id) => recommendation(id)),
        observed: [matched(1), matched(2), mismatched(3, "Thread 3 ran b-1."), matched(4)],
        ...window,
      },
      4,
    );

    assert.deepEqual(result.measure, {
      measure: "routing_adherence",
      state: "ok",
      value: 0.75,
      unit: "ratio",
      direction: "higher_is_better",
      sampleSize: 4,
      missingReason: null,
      provenance: ["routing_recommended", "run.providerInstanceId", "run.modelSelection.model"],
    });
    assert.deepEqual(result.mismatches, [
      {
        threadId: "thread-3",
        tier: "cheap",
        recommended: alpha,
        observed: beta,
        at: "2026-10-01T12:00:00.000Z",
        flag: "Thread 3 ran b-1.",
      },
    ]);
  });

  it("fewer observations than the default minimum of five are unavailable, with the numbers", () => {
    const result = adherence({
      recommended: [1, 2, 3].map((id) => recommendation(id)),
      observed: [matched(1), matched(2), mismatched(3)],
      ...window,
    });

    assert.strictEqual(result.measure.state, "unavailable");
    assert.strictEqual(result.measure.value, null);
    assert.strictEqual(result.measure.sampleSize, 3);
    assert.strictEqual(
      result.measure.missingReason,
      "Needs at least 5 observed launches in this window; found 3.",
    );
    // The mismatch is still a record for whoever reads them.
    assert.lengthOf(result.mismatches, 1);
  });

  it("counts only recommendations that have an observation and name a model", () => {
    const result = adherence(
      {
        recommended: [
          recommendation(1),
          // Its thread has not run yet.
          recommendation(2),
          // The tier resolved to nothing, so the launch inherited a model.
          recommendation(3, undefined, null),
        ],
        observed: [matched(1), matched(3)],
        ...window,
      },
      1,
    );

    assert.strictEqual(result.measure.sampleSize, 1);
    assert.strictEqual(result.measure.value, 1);
  });

  it("windows are half open on the recommendation's time: from counts, to does not", () => {
    const result = adherence(
      {
        recommended: [
          recommendation(1, "2026-09-30T23:59:59.999Z"),
          recommendation(2, window.from),
          recommendation(3, "2026-10-01T23:59:59.999Z"),
          recommendation(4, window.to),
        ],
        observed: [matched(1), matched(2), mismatched(3), matched(4)],
        ...window,
      },
      1,
    );

    assert.strictEqual(result.measure.sampleSize, 2);
    assert.strictEqual(result.measure.value, 0.5);
    assert.deepEqual(
      result.mismatches.map((mismatch) => mismatch.threadId),
      ["thread-3"],
    );
  });

  it("an empty window is unavailable rather than a ratio of nothing", () => {
    const result = adherence({ recommended: [], observed: [], ...window }, 0);

    assert.strictEqual(result.measure.state, "unavailable");
    assert.strictEqual(result.measure.value, null);
    assert.strictEqual(result.measure.sampleSize, 0);
  });
});

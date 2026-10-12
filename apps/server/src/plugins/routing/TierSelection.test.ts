import { assert, describe, it } from "@effect/vitest";
import { ROUTING_TIERS, RoutingTaskClass } from "@t3tools/contracts";

import { selectTier } from "./TierSelection.ts";

describe("selectTier", () => {
  it("each task class starts on its base tier", () => {
    assert.deepEqual(
      RoutingTaskClass.literals.map((taskClass) => [
        taskClass,
        selectTier({ taskClass, failedRuns: 0 }),
      ]),
      [
        ["mechanical", { tier: "cheap", reason: "rule" }],
        ["implementation", { tier: "standard", reason: "rule" }],
        ["planning", { tier: "strong", reason: "rule" }],
        ["design", { tier: "strong", reason: "rule" }],
        ["risky_review", { tier: "strong", reason: "rule" }],
      ],
    );
  });

  it("each failed run moves one tier up and stops at strong", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 7].map((failedRuns) => selectTier({ taskClass: "mechanical", failedRuns })),
      [
        { tier: "cheap", reason: "rule" },
        { tier: "standard", reason: "escalation" },
        { tier: "strong", reason: "escalation" },
        { tier: "strong", reason: "escalation" },
        { tier: "strong", reason: "escalation" },
      ],
    );
    assert.deepEqual(selectTier({ taskClass: "implementation", failedRuns: 1 }), {
      tier: "strong",
      reason: "escalation",
    });
    assert.deepEqual(selectTier({ taskClass: "design", failedRuns: 2 }), {
      tier: "strong",
      reason: "escalation",
    });
  });

  it("a manual tier beats both the rule and escalation", () => {
    for (const manualTier of ROUTING_TIERS) {
      assert.deepEqual(selectTier({ taskClass: "risky_review", failedRuns: 0, manualTier }), {
        tier: manualTier,
        reason: "manual",
      });
      assert.deepEqual(selectTier({ taskClass: "mechanical", failedRuns: 2, manualTier }), {
        tier: manualTier,
        reason: "manual",
      });
    }
  });
});

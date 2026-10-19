import { ROUTING_TIERS, type RoutingTaskClass, type RoutingTier } from "@t3tools/contracts";

/** The tier each task class starts on. */
const BASE_TIER = {
  mechanical: "cheap",
  implementation: "standard",
  planning: "strong",
  design: "strong",
  risky_review: "strong",
} as const satisfies Record<RoutingTaskClass, RoutingTier>;

/**
 * The tier one launch gets. A manual tier wins over everything; otherwise the task class's base
 * tier, one tier up per failed run among earlier launches of the same work, stopping at `strong`.
 */
export const selectTier = (input: {
  readonly taskClass: RoutingTaskClass;
  readonly failedRuns: number;
  readonly manualTier?: RoutingTier | undefined;
}) => {
  if (input.manualTier !== undefined) return { tier: input.manualTier, reason: "manual" } as const;
  const base = ROUTING_TIERS.indexOf(BASE_TIER[input.taskClass]);
  const steps = Math.max(0, input.failedRuns);
  return {
    tier: ROUTING_TIERS[Math.min(base + steps, ROUTING_TIERS.length - 1)]!,
    reason: steps > 0 ? "escalation" : "rule",
  } as const;
};

import * as Schema from "effect/Schema";

/**
 * How much model a task needs. Apart from `routing.ts` because the telemetry contract needs it
 * and `routing.ts` imports the telemetry contract; `routing.ts` exports it.
 */
export const RoutingTier = Schema.Literals(["cheap", "standard", "strong"]);
export type RoutingTier = typeof RoutingTier.Type;
export const ROUTING_TIERS = RoutingTier.literals;

import { ROUTING_TIERS, type RoutingTiers } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Readiness from "../Readiness.ts";
import * as TierMapService from "./TierMapService.ts";

const TIERS: Readiness.Check = { id: "tiers", label: "Tier map", target: "plugins" };

/**
 * Ready when every tier resolves to a saved model the catalog offers. A tier with nothing saved
 * falls back to a guess from one instance's model list, so it is named as well as one whose saved
 * model the catalog dropped.
 */
export const tiersCheck = (tiers: RoutingTiers) => {
  const unsaved = ROUTING_TIERS.filter(
    (tier) => tiers[tier].source === "builtin" || tiers[tier].source === null,
  );
  const dropped = ROUTING_TIERS.filter((tier) => !unsaved.includes(tier) && !tiers[tier].available);
  if (unsaved.length === 0 && dropped.length === 0) {
    return Readiness.ready(TIERS, "Each tier resolves to a saved model the catalog offers.");
  }
  const parts = [
    ...(unsaved.length === 0
      ? []
      : [
          `${Readiness.list(unsaved)} ${unsaved.length === 1 ? "has" : "have"} no saved model, so ${unsaved.length === 1 ? "it falls" : "they fall"} back to a guess from one provider's list`,
        ]),
    ...(dropped.length === 0
      ? []
      : [
          `${Readiness.list(dropped)} ${dropped.length === 1 ? "names a model" : "name models"} the catalog no longer offers`,
        ]),
  ];
  const named = unsaved.length + dropped.length;
  return Readiness.attention(
    TIERS,
    Readiness.sentence(
      `${parts.join("; ")}; set ${named === 1 ? "it" : "them"} in the Routing panel`,
    ),
  );
};

/** Routing's readiness: one check, the tier map for the project, else the environment. */
export class RoutingReadiness extends Context.Service<RoutingReadiness, Readiness.Checks>()(
  "t3/plugins/routing/readiness/RoutingReadiness",
) {}

export const layer = Layer.effect(
  RoutingReadiness,
  Effect.map(TierMapService.TierMapService, (tierMap) =>
    RoutingReadiness.of({
      checks: (projectId) =>
        tierMap.get(projectId === null ? {} : { projectId }).pipe(
          Effect.map(tiersCheck),
          Readiness.orAttention(TIERS),
          Effect.map((check) => [check]),
        ),
    }),
  ),
);

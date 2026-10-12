import {
  ROUTING_METHODS,
  type RoutingTiersGetInput,
  type RoutingTiersSetInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TierMapService from "./TierMapService.ts";

/** The method table needs every entry even when the plugin is off, so an inactive plugin answers with an error. */
const service = Effect.serviceOption(TierMapService.TierMapService).pipe(
  Effect.flatMap(TierMapService.fromOption),
);

/** Each method takes its decoded input. The plugin gateway (#57) will dispatch to these by name. */
export const handlers = {
  [ROUTING_METHODS.tiersGet.method]: (input: RoutingTiersGetInput) =>
    Effect.flatMap(service, (tiers) => tiers.get(input)),
  [ROUTING_METHODS.tiersSet.method]: (input: RoutingTiersSetInput) =>
    Effect.flatMap(service, (tiers) => tiers.set(input)),
};

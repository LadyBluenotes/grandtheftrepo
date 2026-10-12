import { ROUTING_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginRpc from "../PluginRpc.ts";
import * as TierMapService from "./TierMapService.ts";

/** The host dispatches to these even when the plugin is off, so an inactive plugin answers with an error. */
const service = Effect.serviceOption(TierMapService.TierMapService).pipe(
  Effect.flatMap(TierMapService.fromOption),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(ROUTING_METHODS)({
  tiersGet: (input) => Effect.flatMap(service, (tiers) => tiers.get(input)),
  tiersSet: (input) => Effect.flatMap(service, (tiers) => tiers.set(input)),
});

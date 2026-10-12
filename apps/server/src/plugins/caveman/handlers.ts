import { CAVEMAN_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginRpc from "../PluginRpc.ts";
import * as CavemanService from "./CavemanService.ts";

/** The host dispatches to these even when the plugin is off, so an inactive plugin answers with an error. */
const service = Effect.serviceOption(CavemanService.CavemanService).pipe(
  Effect.flatMap(CavemanService.fromOption),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(CAVEMAN_METHODS)({
  status: () => Effect.flatMap(service, (caveman) => caveman.status),
  setRoute: (input) => Effect.flatMap(service, (caveman) => caveman.setRoute(input)),
});

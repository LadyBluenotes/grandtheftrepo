import { POLICY_METHODS, PolicyError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as PolicyService from "./PolicyService.ts";

/** The host dispatches to these even when the plugin is off, so an inactive plugin answers with an error. */
const service = Effect.serviceOption(PolicyService.PolicyService).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new PolicyError({ code: "inactive", message: 'Plugin "policy" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(POLICY_METHODS)({
  create: (input) => Effect.flatMap(service, (policies) => policies.create(input)),
  accept: (input) => Effect.flatMap(service, (policies) => policies.accept(input)),
  install: (input) => Effect.flatMap(service, (policies) => policies.install(input)),
  verify: (input) => Effect.flatMap(service, (policies) => policies.verify(input)),
});

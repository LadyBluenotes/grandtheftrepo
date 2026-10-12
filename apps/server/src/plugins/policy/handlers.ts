import {
  POLICY_WS_METHODS,
  PolicyError,
  type PolicyAcceptInput,
  type PolicyAgentsInput,
  type PolicyCreateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PolicyService from "./PolicyService.ts";

/** The RPC group needs every handler even when the plugin is off, so an inactive plugin answers with an error. */
const service = Effect.serviceOption(PolicyService.PolicyService).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new PolicyError({ code: "inactive", message: 'Plugin "policy" is not running.' }),
      onSome: Effect.succeed,
    }),
  ),
);

/** Spread into the WebSocket handlers through `PluginHost.handlers`. */
export const handlers = {
  [POLICY_WS_METHODS.create]: (input: PolicyCreateInput) =>
    Effect.flatMap(service, (s) => s.create(input)),
  [POLICY_WS_METHODS.accept]: (input: PolicyAcceptInput) =>
    Effect.flatMap(service, (s) => s.accept(input)),
  [POLICY_WS_METHODS.install]: (input: PolicyAgentsInput) =>
    Effect.flatMap(service, (s) => s.install(input)),
  [POLICY_WS_METHODS.verify]: (input: PolicyAgentsInput) =>
    Effect.flatMap(service, (s) => s.verify(input)),
};

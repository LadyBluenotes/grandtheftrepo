import {
  POLICY_WS_METHODS,
  PolicyError,
  type PolicyWriteInput,
  type PolicyWriteResult,
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

const write = (
  policies: PolicyService.PolicyService["Service"],
  input: PolicyWriteInput,
): Effect.Effect<PolicyWriteResult, PolicyError> => {
  switch (input.action) {
    case "create":
      return policies.create(input);
    case "accept":
      return policies.accept(input);
    case "install":
      return policies.install(input);
    case "verify":
      return policies.verify(input);
  }
};

/** Spread into the WebSocket handlers through `PluginHost.handlers`. */
export const handlers = {
  [POLICY_WS_METHODS.write]: (input: PolicyWriteInput) =>
    Effect.flatMap(service, (policies) => write(policies, input)),
};

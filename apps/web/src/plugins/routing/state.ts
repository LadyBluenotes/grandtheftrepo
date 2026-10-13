import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  ROUTING_METHODS,
  RoutingError,
  type RoutingScope,
  type RoutingTiersSetInput,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePluginEnvironmentId } from "../pluginState";

const routingTiers = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:routing",
  method: ROUTING_METHODS.tiersGet,
});

const routingSetTier = createPluginRpcCommand(connectionAtomRuntime, {
  label: "routing:set-tier",
  method: ROUTING_METHODS.tiersSet,
});

/** The Plugins page environment's resolved tiers, or one project's when `scope` names it. */
export function useRoutingTiers(scope: RoutingScope) {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : routingTiers({
          environmentId,
          input: scope === "environment" ? {} : { projectId: scope },
        }),
  );
}

/** Saves one tier on the Plugins page's environment; `canWrite` follows the settings grant. */
export function useRoutingSetTier() {
  const environmentId = usePluginEnvironmentId();
  const run = useAtomCommand(routingSetTier, { reportFailure: false });
  const canWrite = useAtomValue(routingSetTier.permissionAtom(environmentId));
  return {
    canWrite,
    set: (input: RoutingTiersSetInput) =>
      environmentId === null
        ? Promise.resolve(
            AsyncResult.failure(
              Cause.fail(
                new RoutingError({ code: "inactive", message: "No environment is connected." }),
              ),
            ),
          )
        : run({ environmentId, input }),
  };
}

/**
 * The models the server accepts for a tier on this instance: the catalog's, minus the ones the
 * user hid from pickers. The server applies the same rule when it saves.
 */
export function offeredModels(
  provider: ServerProvider,
  preferences: ServerSettings["providerModelPreferences"],
): ReadonlyArray<ServerProviderModel> {
  const hidden = preferences?.[provider.instanceId]?.hiddenModels ?? [];
  return provider.models.filter((model) => model.isCustom || !hidden.includes(model.slug));
}

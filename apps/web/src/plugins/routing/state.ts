import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  RoutingError,
  type RoutingScope,
  type RoutingTiers,
  type RoutingTiersSetInput,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import type { EnvironmentQueryView } from "~/state/query";

const UNAVAILABLE = "Routing settings arrive with the plugin gateway.";

/*
 * Placeholder data layer. The plugin RPC gateway (#57) carries `ROUTING_METHODS.tiersGet` and
 * `.tiersSet`; until it lands nothing here calls the server. Then `useRoutingTiers` becomes
 * `useEnvironmentQuery` over `createPluginRpcQueryAtomFamily(ROUTING_METHODS.tiersGet)` and
 * `useRoutingSetTier` wraps `createPluginRpcCommand(ROUTING_METHODS.tiersSet)` with its
 * `permissionAtom` as `canWrite`; the panel does not change.
 */

/** The resolved tiers for the environment, or for the project when `scope` names one. */
export function useRoutingTiers(_scope: RoutingScope): EnvironmentQueryView<RoutingTiers> {
  return {
    data: null,
    dataUpdatedAt: 0,
    error: UNAVAILABLE,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => undefined,
  };
}

export function useRoutingSetTier(): {
  readonly canWrite: boolean;
  readonly set: (
    input: RoutingTiersSetInput,
  ) => Promise<AtomCommandResult<RoutingTiers, RoutingError>>;
} {
  return {
    canWrite: false,
    set: () =>
      Promise.resolve(
        AsyncResult.failure(
          Cause.fail(new RoutingError({ code: "inactive", message: UNAVAILABLE })),
        ),
      ),
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

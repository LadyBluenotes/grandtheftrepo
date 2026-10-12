import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import { CAVEMAN_METHODS, CavemanError, type CavemanSetRouteInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const cavemanStatus = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:caveman",
  method: CAVEMAN_METHODS.status,
});

const cavemanSetRoute = createPluginRpcCommand(connectionAtomRuntime, {
  label: "caveman:set-route",
  method: CAVEMAN_METHODS.setRoute,
});

/** Caveman's install state, proxy and per-instance routes on the primary environment. */
export function useCavemanStatus() {
  const environmentId = usePrimaryEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : cavemanStatus({ environmentId, input: {} }),
  );
}

/** Switches one instance's route on the primary environment; `canWrite` follows the settings grant. */
export function useCavemanSetRoute() {
  const environmentId = usePrimaryEnvironmentId();
  const run = useAtomCommand(cavemanSetRoute, { reportFailure: false });
  const canWrite = useAtomValue(cavemanSetRoute.permissionAtom(environmentId));
  return {
    canWrite,
    set: (input: CavemanSetRouteInput) =>
      environmentId === null
        ? Promise.resolve(
            AsyncResult.failure(
              Cause.fail(
                new CavemanError({ code: "inactive", message: "No environment is connected." }),
              ),
            ),
          )
        : run({ environmentId, input }),
  };
}

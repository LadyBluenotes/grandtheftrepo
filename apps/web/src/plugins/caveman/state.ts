import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  CAVEMAN_METHODS,
  CavemanError,
  type CavemanLearnFinding,
  type CavemanLearnSource,
  type CavemanSetRouteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePluginEnvironmentId } from "../pluginState";

const cavemanStatus = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:caveman",
  method: CAVEMAN_METHODS.status,
});

const cavemanSetRoute = createPluginRpcCommand(connectionAtomRuntime, {
  label: "caveman:set-route",
  method: CAVEMAN_METHODS.setRoute,
});

const cavemanLearnPlan = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:caveman:learn-plan",
  method: CAVEMAN_METHODS.learnPlan,
  // A scan runs for up to three minutes, and the next sweep tick imports its report.
  refreshIntervalMs: 15_000,
});

const cavemanLearnRefresh = createPluginRpcCommand(connectionAtomRuntime, {
  label: "caveman:learn-refresh",
  method: CAVEMAN_METHODS.learnRefresh,
});

const notConnected = () =>
  Promise.resolve(
    AsyncResult.failure(
      Cause.fail(new CavemanError({ code: "inactive", message: "No environment is connected." })),
    ),
  );

/** Caveman's install state, proxy and per-instance routes on the Plugins page's environment. */
export function useCavemanStatus() {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : cavemanStatus({ environmentId, input: {} }),
  );
}

/** Switches one instance's route on the Plugins page's environment; `canWrite` follows the settings grant. */
export function useCavemanSetRoute() {
  const environmentId = usePluginEnvironmentId();
  const run = useAtomCommand(cavemanSetRoute, { reportFailure: false });
  const canWrite = useAtomValue(cavemanSetRoute.permissionAtom(environmentId));
  return {
    canWrite,
    set: (input: CavemanSetRouteInput) =>
      environmentId === null ? notConnected() : run({ environmentId, input }),
  };
}

/** The newest `caveman learn` plan on the Plugins page's environment, with every sink and the scan's state. */
export function useCavemanLearnPlan() {
  const environmentId = usePluginEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : cavemanLearnPlan({ environmentId, input: {} }),
  );
}

/** Starts a `caveman learn` scan on the Plugins page's environment; `canWrite` follows the settings grant. */
export function useCavemanLearnRefresh() {
  const environmentId = usePluginEnvironmentId();
  const run = useAtomCommand(cavemanLearnRefresh, { reportFailure: false });
  const canWrite = useAtomValue(cavemanLearnRefresh.permissionAtom(environmentId));
  return {
    canWrite,
    refresh: () => (environmentId === null ? notConnected() : run({ environmentId, input: {} })),
  };
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** A sink's tokens as the panel shows them: per message going forward, or observed in the window. */
export function sinkTokensLabel(
  sink: Pick<CavemanLearnFinding, "framing" | "tokensPerTurn" | "tokensObserved">,
) {
  const [count, unit] =
    sink.framing === "forward_rate"
      ? [sink.tokensPerTurn, "tokens per message"]
      : [sink.tokensObserved, "tokens observed"];
  return count === null ? "No token estimate" : `${compact.format(count)} ${unit}, estimate`;
}

/** Where caveman looked for project instruction files when it wrote a plan from `source`. */
export function scanScopeLabel(source: CavemanLearnSource) {
  return source === "canonical"
    ? "Project instruction files were scanned from the home directory up."
    : "Project instruction files were scanned from the last session's directory up.";
}

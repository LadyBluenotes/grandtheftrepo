import { useAtomValue } from "@effect/atom-react";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  SUPERVISOR_METHODS,
  type SupervisorStatus,
  type TelemetryBudgetPatch,
  TELEMETRY_METHODS,
  TelemetryError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const supervisorStatus = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:supervisor",
  method: SUPERVISOR_METHODS.status,
  // The supervisor ticks every 60 seconds by default; "Last tick" follows it while the page is open.
  refreshIntervalMs: 60_000,
});

const telemetryBudgets = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:telemetry-budgets",
  method: TELEMETRY_METHODS.budgets,
});

const budgetsSet = createPluginRpcCommand(connectionAtomRuntime, {
  label: "telemetry:set-budget",
  method: TELEMETRY_METHODS.budgetsSet,
});

const budgetsRemove = createPluginRpcCommand(connectionAtomRuntime, {
  label: "telemetry:remove-budget",
  method: TELEMETRY_METHODS.budgetsRemove,
});

/** The primary environment's supervisor, as `usePluginStatuses` reads its plugins; null while loading or failed. */
export function useSupervisorStatus(): SupervisorStatus | null {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : supervisorStatus({ environmentId, input: {} }),
  );
  return query.error === null ? query.data : null;
}

/** When the latest tick that ran `telemetry/heartbeat` finished, or null before the first. */
export function lastHeartbeat(status: SupervisorStatus | null): string | null {
  const latest = status?.latest ?? null;
  if (latest === null) return null;
  return latest.sweeps.some((sweep) => sweep.plugin === "telemetry" && sweep.name === "heartbeat")
    ? latest.finishedAt
    : null;
}

/** The primary environment's budgets, each with its state over every project it judges. */
export function useTelemetryBudgets() {
  const environmentId = usePrimaryEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : telemetryBudgets({ environmentId, input: {} }),
  );
}

const noEnvironment = () =>
  Promise.resolve(
    AsyncResult.failure(
      Cause.fail(new TelemetryError({ message: "No environment is connected." })),
    ),
  );

/** Saves and removes budgets on the primary environment; `canWrite` follows the settings grant. */
export function useTelemetryBudgetCommands() {
  const environmentId = usePrimaryEnvironmentId();
  const runSet = useAtomCommand(budgetsSet, { reportFailure: false });
  const runRemove = useAtomCommand(budgetsRemove, { reportFailure: false });
  const canWrite = useAtomValue(budgetsSet.permissionAtom(environmentId));
  return {
    canWrite,
    /** Changes only the fields `patch` names, so another client's edit to the rest stands. */
    save: (patch: TelemetryBudgetPatch) =>
      environmentId === null ? noEnvironment() : runSet({ environmentId, input: patch }),
    remove: (id: number) =>
      environmentId === null ? noEnvironment() : runRemove({ environmentId, input: { id } }),
  };
}

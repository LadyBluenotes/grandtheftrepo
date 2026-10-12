import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { SUPERVISOR_WS_METHODS, type SupervisorStatus } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

const supervisorStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:supervisor",
  tag: SUPERVISOR_WS_METHODS.status,
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

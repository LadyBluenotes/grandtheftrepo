import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import { HOST_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

const pluginStatuses = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:host",
  method: HOST_METHODS.list,
});

export const pluginSetEnabled = createPluginRpcCommand(connectionAtomRuntime, {
  label: "plugins:set-enabled",
  method: HOST_METHODS.setEnabled,
});

/**
 * The primary environment's plugins; other environments' are not shown. `statuses` is null while
 * loading, and when the call fails, as it does on a server without the plugin host.
 */
export function usePluginStatuses() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : pluginStatuses({ environmentId, input: {} }),
  );
  return {
    environmentId,
    statuses: query.error === null ? query.data : null,
    isPending: query.isPending,
    refresh: query.refresh,
  };
}

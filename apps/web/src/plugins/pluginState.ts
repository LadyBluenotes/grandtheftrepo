import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { PLUGIN_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

const pluginStatuses = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:host",
  tag: PLUGIN_WS_METHODS.pluginsList,
});

export const pluginSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins:set-enabled",
  tag: PLUGIN_WS_METHODS.pluginsSetEnabled,
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

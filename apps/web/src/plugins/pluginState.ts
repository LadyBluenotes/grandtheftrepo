import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import {
  DEFAULT_SERVER_SETTINGS,
  HOST_METHODS,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createContext, useContext } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
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

/** The environment a link opened the Plugins page for, such as the board's; null for the primary. */
export const PluginEnvironmentContext = createContext<EnvironmentId | null>(null);

/** The environment plugin screens and panels read and write: the page's, else the primary. */
export function usePluginEnvironmentId(): EnvironmentId | null {
  const scoped = useContext(PluginEnvironmentContext);
  const primary = usePrimaryEnvironmentId();
  return scoped ?? primary;
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** The providers and settings of the environment `usePluginEnvironmentId` names. */
export function usePluginServerConfig() {
  const environmentId = usePluginEnvironmentId();
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  return {
    providers: config?.providers ?? NO_PROVIDERS,
    settings: config?.settings ?? DEFAULT_SERVER_SETTINGS,
  };
}

/**
 * The plugins of the environment `usePluginEnvironmentId` names. `statuses` is null while loading,
 * and when the call fails, as it does on a server without the plugin host.
 */
export function usePluginStatuses() {
  const environmentId = usePluginEnvironmentId();
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

import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";

import { PLUGINS_UNSUPPORTED, pluginScreenView } from "./pluginRoute";
import { PluginEnvironmentContext, usePluginEnvironmentId, usePluginStatuses } from "./pluginState";
import { PluginNotice, PluginPageShell } from "./PluginsPage";
import { pluginRegistry } from "./registry";

/**
 * `/plugins/<id>`: the plugin's own screen, or one line saying why there is none, for the
 * environment a link named, such as the board's for a flag, else the primary one.
 */
export function PluginScreen({
  pluginId,
  environmentId,
}: {
  readonly pluginId: string;
  readonly environmentId: EnvironmentId | null;
}) {
  return (
    <PluginEnvironmentContext.Provider value={environmentId}>
      <KeyedPluginScreenBody pluginId={pluginId} environmentId={environmentId} />
    </PluginEnvironmentContext.Provider>
  );
}

/**
 * Keyed by the environment the screen shows, the primary one resolved: a screen's state, such as
 * a selected project, belongs to one environment.
 */
function KeyedPluginScreenBody(props: {
  readonly pluginId: string;
  readonly environmentId: EnvironmentId | null;
}) {
  const shown = usePluginEnvironmentId();
  return <PluginScreenBody key={shown ?? "none"} {...props} />;
}

function PluginScreenBody({
  pluginId,
  environmentId,
}: {
  readonly pluginId: string;
  readonly environmentId: EnvironmentId | null;
}) {
  const { statuses, isPending } = usePluginStatuses();
  if (statuses === null) {
    return (
      <PluginPageShell>
        {isPending ? null : <PluginNotice>{PLUGINS_UNSUPPORTED}</PluginNotice>}
      </PluginPageShell>
    );
  }
  const view = pluginScreenView(pluginId, statuses, pluginRegistry);
  if (view.kind === "screen") {
    return (
      <Suspense fallback={null}>
        <view.Screen />
      </Suspense>
    );
  }
  return (
    <PluginPageShell>
      <PluginNotice>
        {view.message}
        {view.linkToPlugins ? (
          <>
            {" "}
            <Link to="/plugins" search={environmentId === null ? {} : { machine: environmentId }}>
              Plugins
            </Link>
          </>
        ) : null}
      </PluginNotice>
    </PluginPageShell>
  );
}

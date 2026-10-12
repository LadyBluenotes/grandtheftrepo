import { Link } from "@tanstack/react-router";
import { Suspense } from "react";

import { PLUGINS_UNSUPPORTED, pluginScreenView } from "./pluginRoute";
import { usePluginStatuses } from "./pluginState";
import { PluginNotice, PluginPageShell } from "./PluginsPage";
import { pluginRegistry } from "./registry";

/** `/plugins/<id>`: the plugin's own screen, or one line saying why there is none. */
export function PluginScreen({ pluginId }: { readonly pluginId: string }) {
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
            <Link to="/plugins">Plugins</Link>
          </>
        ) : null}
      </PluginNotice>
    </PluginPageShell>
  );
}

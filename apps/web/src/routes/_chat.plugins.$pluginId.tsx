import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { PluginScreen } from "../plugins/PluginScreen";
import { validatePluginScreenSearch } from "../plugins/pluginScreenSearch";

// Plugin seam: mounts any running plugin's screen by id. Screens live in `plugins/`.
export const Route = createFileRoute("/_chat/plugins/$pluginId")({
  validateSearch: validatePluginScreenSearch,
  component: PluginRoute,
});

function PluginRoute() {
  const { machine } = Route.useSearch();
  return (
    <PluginScreen
      pluginId={Route.useParams().pluginId}
      environmentId={machine === undefined ? null : EnvironmentId.make(machine)}
    />
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { PluginScreen } from "../plugins/PluginScreen";

// Plugin seam: mounts any running plugin's screen by id. Screens live in `plugins/`.
export const Route = createFileRoute("/_chat/plugins/$pluginId")({
  component: PluginRoute,
});

function PluginRoute() {
  return <PluginScreen pluginId={Route.useParams().pluginId} />;
}

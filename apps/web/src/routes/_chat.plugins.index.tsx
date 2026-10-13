import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";
import { PluginsPage } from "../plugins/PluginsPage";

// Plugin seam: the host's own page. It must stay an index route, since a `_chat.plugins.tsx`
// would become the layout parent of the screen route. `machine` scopes it to one environment,
// as it does a settings page.
export const Route = createFileRoute("/_chat/plugins/")({
  validateSearch: validateSettingsRouteSearch,
  component: PluginsRoute,
});

function PluginsRoute() {
  const { machine } = Route.useSearch();
  return <PluginsPage environmentId={machine === undefined ? null : EnvironmentId.make(machine)} />;
}

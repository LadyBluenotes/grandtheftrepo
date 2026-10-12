import { createFileRoute } from "@tanstack/react-router";

import { PluginsPage } from "../plugins/PluginsPage";

// Plugin seam: the host's own page. It must stay an index route, since a `_chat.plugins.tsx`
// would become the layout parent of the screen route.
export const Route = createFileRoute("/_chat/plugins/")({
  component: PluginsPage,
});

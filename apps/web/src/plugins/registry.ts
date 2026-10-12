import type { PluginStatus } from "@t3tools/contracts";
import { RouteIcon, SquareKanbanIcon, type LucideIcon } from "lucide-react";
import type { ComponentType, LazyExoticComponent } from "react";

import { SettingsPanel as RoutingSettingsPanel } from "./routing/SettingsPanel";

/**
 * What the web knows about a plugin. The server's `plugins.list` says whether it runs.
 * A `Screen` is `React.lazy` and renders its whole page, header included, at `/plugins/<id>`.
 * A `SettingsPanel` shows under the plugin's row on the Plugins page while it runs.
 */
export interface PluginEntry {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly Screen?: LazyExoticComponent<ComponentType>;
  readonly SettingsPanel?: ComponentType<{ readonly status: PluginStatus }>;
}

export const pluginRegistry: ReadonlyArray<PluginEntry> = [
  // The board keeps its own route, `/board`, so it has no `Screen` here.
  { id: "kanban", title: "Board", icon: SquareKanbanIcon },
  { id: "routing", title: "Routing", icon: RouteIcon, SettingsPanel: RoutingSettingsPanel },
];

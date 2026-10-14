import type { PluginStatus } from "@t3tools/contracts";
import {
  ActivityIcon,
  BookOpenTextIcon,
  GraduationCapIcon,
  RouteIcon,
  ScrollTextIcon,
  ShrinkIcon,
  SquareKanbanIcon,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import { SettingsPanel as RoutingSettingsPanel } from "./routing/SettingsPanel";
import { TelemetrySettingsPanel } from "./telemetry/SettingsPanel";

const CavemanScreen = lazy(() =>
  import("./caveman/CavemanScreen").then((module) => ({ default: module.CavemanScreen })),
);

const LearningScreen = lazy(() =>
  import("./learning/LearningScreen").then((module) => ({ default: module.LearningScreen })),
);

/**
 * What the web knows about a plugin. The server's `plugins.list` says whether it runs.
 * A `Screen` is `React.lazy` and renders its whole page, header included, at `/plugins/<id>`.
 * A `SettingsPanel` shows under the plugin's row on the Plugins page while it runs.
 */
export interface PluginEntry {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  /** One line for the Plugins page: what the plugin is for. */
  readonly summary?: string;
  readonly Screen?: LazyExoticComponent<ComponentType>;
  readonly SettingsPanel?: ComponentType<{ readonly status: PluginStatus }>;
}

export const pluginRegistry: ReadonlyArray<PluginEntry> = [
  // The board keeps its own route, `/board`, so it has no `Screen` here.
  { id: "kanban", title: "Board", icon: SquareKanbanIcon },
  {
    id: "telemetry",
    title: "Telemetry",
    icon: ActivityIcon,
    SettingsPanel: TelemetrySettingsPanel,
  },
  { id: "routing", title: "Routing", icon: RouteIcon, SettingsPanel: RoutingSettingsPanel },
  { id: "learning", title: "Learning", icon: GraduationCapIcon, Screen: LearningScreen },
  {
    id: "caveman",
    title: "Caveman",
    icon: ShrinkIcon,
    summary: "Routes Claude Code and Codex through a local proxy and shows where your tokens go.",
    Screen: CavemanScreen,
  },
  {
    id: "policy",
    title: "Policies",
    icon: ScrollTextIcon,
    Screen: lazy(() =>
      import("./policy/PolicyScreen").then((module) => ({ default: module.PolicyScreen })),
    ),
  },
  {
    id: "knowledge",
    title: "Knowledge",
    icon: BookOpenTextIcon,
    Screen: lazy(() => import("./knowledge/KnowledgePage")),
  },
];

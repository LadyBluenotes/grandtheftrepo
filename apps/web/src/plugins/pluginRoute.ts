import type { PluginStatus } from "@t3tools/contracts";

import type { PluginEntry } from "./registry";

export const PLUGINS_UNSUPPORTED = "This environment does not support plugins.";

export type PluginScreenView =
  | { readonly kind: "screen"; readonly Screen: NonNullable<PluginEntry["Screen"]> }
  | { readonly kind: "notice"; readonly message: string; readonly linkToPlugins: boolean };

/** The screen to mount for `/plugins/<id>`, or the one line to show instead. */
export function pluginScreenView(
  id: string,
  statuses: ReadonlyArray<PluginStatus>,
  registry: ReadonlyArray<PluginEntry>,
): PluginScreenView {
  const status = statuses.find((candidate) => candidate.id === id);
  if (status === undefined) {
    return { kind: "notice", message: `No plugin named "${id}".`, linkToPlugins: false };
  }
  const entry = registry.find((candidate) => candidate.id === id);
  const title = entry?.title ?? id;
  if (!status.active) {
    return { kind: "notice", message: `${title} is not running.`, linkToPlugins: true };
  }
  if (entry?.Screen === undefined) {
    return { kind: "notice", message: `${title} has no screen.`, linkToPlugins: false };
  }
  return { kind: "screen", Screen: entry.Screen };
}

export interface PluginBadge {
  readonly label: string;
  readonly variant: "success" | "secondary" | "warning" | "error";
}

const RUNNING: PluginBadge = { label: "Running", variant: "success" };
const RESTART: PluginBadge = { label: "Restart to apply", variant: "warning" };
const OFF: PluginBadge = { label: "Off", variant: "secondary" };

/**
 * `active` is what this process runs; `enabled` is the saved choice that applies on restart.
 * They disagree exactly when a restart would change something, unless a dependency is off.
 */
export function pluginBadge(status: PluginStatus): PluginBadge {
  if (status.startError !== null) return { label: status.startError, variant: "error" };
  if (status.active) return status.enabled ? RUNNING : RESTART;
  if (status.missing.length > 0) {
    return { label: `Needs ${status.missing.join(", ")}`, variant: "warning" };
  }
  return status.enabled ? RESTART : OFF;
}

/** Registry entries that get a sidebar button: running, with a screen to open. */
export function sidebarPlugins(
  statuses: ReadonlyArray<PluginStatus>,
  registry: ReadonlyArray<PluginEntry>,
): ReadonlyArray<PluginEntry> {
  return registry.filter(
    (entry) =>
      entry.Screen !== undefined &&
      statuses.some((status) => status.id === entry.id && status.active),
  );
}

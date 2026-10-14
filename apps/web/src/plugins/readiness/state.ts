import { useAtomSet } from "@effect/atom-react";
import { createPluginRpcQueryAtomFamily } from "@t3tools/client-runtime/plugins/rpc";
import {
  HOST_METHODS,
  type EnvironmentId,
  type PluginReadiness,
  type ProjectId,
  type ReadinessCheck,
  type ReadinessStatus,
  type ReadinessTarget,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { pluginScreenLink } from "../pluginRoute";

/** Bumped after a command on the Plugins page, such as a saved tier, so the checklist re-reads. */
const changed = Atom.make(0).pipe(Atom.keepAlive);
const refreshSignal = Atom.make((get) => `${get(Atom.windowFocusSignal)}:${get(changed)}`);

/**
 * Nothing pushes readiness to clients, and it never polls: it is stale at once, so it re-reads
 * each time the page opens, and again when the window regains focus or a command on the page
 * calls `useReadinessChanged`.
 */
const pluginReadiness = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins:readiness",
  method: HOST_METHODS.readiness,
  staleTimeMs: 0,
  refreshTrigger: () => refreshSignal,
});

/** Every plugin's checks on `environmentId`; without a project, those that need one are left out. */
export function usePluginReadiness(environmentId: EnvironmentId, projectId: ProjectId | null) {
  return useEnvironmentQuery(
    pluginReadiness({ environmentId, input: projectId === null ? {} : { projectId } }),
  );
}

/** Call after a command that can change a check; the checklist re-reads. */
export function useReadinessChanged() {
  const set = useAtomSet(changed);
  return () => set((count) => count + 1);
}

export interface ReadinessGroup {
  readonly plugin: string;
  readonly title: string;
  /** `attention` when any check needs it, else `off` when any is off, else `ready`. */
  readonly status: ReadinessStatus;
  /** Checks that are not ready, shown with their sentence and link. */
  readonly open: ReadonlyArray<ReadinessCheck>;
  /** Ready checks, collapsed until asked for. */
  readonly ready: ReadonlyArray<ReadinessCheck>;
}

/** The report grouped by plugin in the server's order; a plugin with no checks is left out. */
export function readinessGroups(
  report: ReadonlyArray<PluginReadiness>,
  titleOf: (plugin: string) => string,
): ReadonlyArray<ReadinessGroup> {
  return report.flatMap(({ plugin, checks }) => {
    if (checks.length === 0) return [];
    const open = checks.filter((check) => check.status !== "ready");
    return [
      {
        plugin,
        title: titleOf(plugin),
        status: open.some((check) => check.status === "attention")
          ? "attention"
          : open.length > 0
            ? "off"
            : "ready",
        open,
        ready: checks.filter((check) => check.status === "ready"),
      },
    ];
  });
}

export const GROUP_BADGE: Record<
  ReadinessStatus,
  { readonly label: string; readonly variant: "warning" | "secondary" | "success" }
> = {
  attention: { label: "Needs attention", variant: "warning" },
  off: { label: "Off", variant: "secondary" },
  ready: { label: "Ready", variant: "success" },
};

/** Where a check's link goes: a plugin's row on this page, or another screen. */
export type ReadinessLink =
  | { readonly kind: "row"; readonly plugin: string; readonly label: string }
  | ({ readonly kind: "screen"; readonly label: string } & ReturnType<typeof pluginScreenLink>)
  | {
      readonly kind: "board";
      readonly to: "/board";
      readonly search: { readonly environmentId: EnvironmentId; readonly projectId?: ProjectId };
      readonly label: string;
    }
  | { readonly kind: "usage"; readonly to: "/usage"; readonly label: string }
  | {
      readonly kind: "scheduled_tasks";
      readonly to: "/settings/scheduled-tasks";
      readonly search: { readonly environmentId: EnvironmentId };
      readonly label: string;
    };

/** The plugin row's element id on the Plugins page, which a `row` link scrolls to. */
export const pluginRowId = (plugin: string) => `plugin-${plugin}`;

/**
 * A check's link. `plugin` opens the plugin's own screen, on the checklist's environment, when it
 * has one; otherwise it is the plugin's row on this page, as `plugins` always is.
 */
export function readinessLink(
  target: ReadinessTarget | null,
  context: {
    readonly plugin: string;
    readonly title: string;
    readonly hasScreen: boolean;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
  },
): ReadinessLink | null {
  const row = { kind: "row", plugin: context.plugin, label: `${context.title} settings` } as const;
  switch (target) {
    case null:
      return null;
    case "plugins":
      return row;
    case "plugin":
      return context.hasScreen
        ? {
            kind: "screen",
            label: `Open ${context.title}`,
            ...pluginScreenLink(context.plugin, context.environmentId),
          }
        : row;
    case "board":
      return {
        kind: "board",
        to: "/board",
        search: {
          environmentId: context.environmentId,
          ...(context.projectId === null ? {} : { projectId: context.projectId }),
        },
        label: "Open board",
      };
    case "usage":
      return { kind: "usage", to: "/usage", label: "Open Usage" };
    case "scheduled_tasks":
      return {
        kind: "scheduled_tasks",
        to: "/settings/scheduled-tasks",
        search: { environmentId: context.environmentId },
        label: "Open scheduled tasks",
      };
  }
}

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { PLUGINS_UNSUPPORTED, pluginBadge } from "./pluginRoute";
import { PluginEnvironmentContext, pluginSetEnabled, usePluginStatuses } from "./pluginState";
import { ReadinessChecklist } from "./readiness/Checklist";
import { pluginRowId, useReadinessChanged } from "./readiness/state";
import { pluginRegistry } from "./registry";

/**
 * The page frame the Plugins page and a plugin's notice share. `environment` names the environment
 * shown when it is not the primary one.
 */
export function PluginPageShell({
  environment,
  children,
}: {
  readonly environment?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Plugins breadcrumb">
            <WorkspaceBreadcrumbItem>
              <h1>Plugins</h1>
            </WorkspaceBreadcrumbItem>
            {environment === undefined ? null : (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>{environment}</WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}

export function PluginNotice({ children }: { readonly children: ReactNode }) {
  return (
    <Empty className="m-auto">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * Every plugin of one environment, with its switch and settings: the environment a link named,
 * such as the board's for a budget flag, else the primary one.
 */
export function PluginsPage({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  return (
    <PluginEnvironmentContext.Provider value={environmentId}>
      <PluginsList />
    </PluginEnvironmentContext.Provider>
  );
}

function PluginsList() {
  const { environmentId, statuses, isPending, refresh } = usePluginStatuses();
  const primary = usePrimaryEnvironmentId();
  const named = useEnvironment(environmentId === primary ? null : environmentId);
  const setEnabled = useAtomCommand(pluginSetEnabled, { reportFailure: false });
  const canWrite = useAtomValue(pluginSetEnabled.permissionAtom(environmentId));
  const readinessChanged = useReadinessChanged();

  const toggle = async (id: string, enabled: boolean) => {
    if (environmentId === null) return;
    const result = await setEnabled({ environmentId, input: { id, enabled } });
    if (result._tag === "Success") {
      refresh();
      readinessChanged();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not change the plugin",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  return (
    <PluginPageShell environment={named?.label}>
      {statuses === null ? (
        isPending ? null : (
          <PluginNotice>{PLUGINS_UNSUPPORTED}</PluginNotice>
        )
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <ReadinessChecklist />
            <SettingsSection title="Plugins" hideTitle>
              {statuses.map((status) => {
                const entry = pluginRegistry.find((candidate) => candidate.id === status.id);
                const title = entry?.title ?? status.id;
                const badge = pluginBadge(status);
                const SettingsPanel = status.active ? entry?.SettingsPanel : undefined;
                return (
                  <SettingsRow
                    key={status.id}
                    id={pluginRowId(status.id)}
                    title={title}
                    status={
                      <div className="max-w-full overflow-hidden">
                        <Badge size="sm" variant={badge.variant} title={badge.label}>
                          {badge.label}
                        </Badge>
                      </div>
                    }
                    control={
                      <Switch
                        aria-label={`Enable ${title}`}
                        checked={status.enabled}
                        disabled={!canWrite}
                        onCheckedChange={(enabled) => void toggle(status.id, enabled)}
                      />
                    }
                  >
                    {SettingsPanel ? <SettingsPanel status={status} /> : null}
                  </SettingsRow>
                );
              })}
            </SettingsSection>
          </WorkspacePageContainer>
        </ScrollArea>
      )}
    </PluginPageShell>
  );
}

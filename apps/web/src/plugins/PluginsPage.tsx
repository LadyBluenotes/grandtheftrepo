import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ReactNode } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useAtomCommand } from "~/state/use-atom-command";
import { PLUGINS_UNSUPPORTED, pluginBadge } from "./pluginRoute";
import { pluginSetEnabled, usePluginStatuses } from "./pluginState";
import { pluginRegistry } from "./registry";

/** The page frame the Plugins page and a plugin's notice share. */
export function PluginPageShell({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Plugins breadcrumb">
            <WorkspaceBreadcrumbItem>
              <h1>Plugins</h1>
            </WorkspaceBreadcrumbItem>
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

export function PluginsPage() {
  const { environmentId, statuses, isPending, refresh } = usePluginStatuses();
  const setEnabled = useAtomCommand(pluginSetEnabled, { reportFailure: false });
  const canWrite = useAtomValue(pluginSetEnabled.permissionAtom(environmentId));

  const toggle = async (id: string, enabled: boolean) => {
    if (environmentId === null) return;
    const result = await setEnabled({ environmentId, input: { id, enabled } });
    if (result._tag === "Success") {
      refresh();
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
    <PluginPageShell>
      {statuses === null ? (
        isPending ? null : (
          <PluginNotice>{PLUGINS_UNSUPPORTED}</PluginNotice>
        )
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <SettingsSection title="Plugins" hideTitle>
              {statuses.map((status) => {
                const entry = pluginRegistry.find((candidate) => candidate.id === status.id);
                const title = entry?.title ?? status.id;
                const badge = pluginBadge(status);
                const SettingsPanel = status.active ? entry?.SettingsPanel : undefined;
                return (
                  <SettingsRow
                    key={status.id}
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

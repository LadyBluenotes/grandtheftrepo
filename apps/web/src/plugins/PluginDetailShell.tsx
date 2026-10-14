import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { useContext, type ReactNode } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { PluginEnvironmentContext } from "./pluginState";

export interface PluginDetailTab<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

/** A plugin's own page: a breadcrumb back to Plugins, a tab switch in the header, the active tab below. */
export function PluginDetailShell<Id extends string>({
  title,
  icon: Icon,
  tabs,
  tab,
  onTabChange,
  children,
}: {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly tabs: ReadonlyArray<PluginDetailTab<Id>>;
  readonly tab: Id;
  readonly onTabChange: (tab: Id) => void;
  readonly children: ReactNode;
}) {
  const environmentId = useContext(PluginEnvironmentContext);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={`${title} breadcrumb`} className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <Link to="/plugins" search={environmentId === null ? {} : { machine: environmentId }}>
                Plugins
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="inline-flex items-center gap-1.5">
                <Icon className="size-4" />
                {title}
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ml-auto">
            <ToggleGroup
              aria-label="View"
              value={[tab]}
              onValueChange={(next) => {
                const picked = tabs.find((candidate) => candidate.id === next[0]);
                if (picked !== undefined) onTabChange(picked.id);
              }}
            >
              {tabs.map((candidate) => (
                <Toggle key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

import { POLICY_ENVIRONMENT_PROJECT_ID, type ProjectId } from "@t3tools/contracts";
import { PlusIcon, ScrollTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { useProjects } from "~/state/entities";
import { DeliveryStatus } from "./DeliveryStatus";
import { NewPolicyForm, PolicyEditor } from "./PolicyEditor";
import { PolicyList } from "./PolicyList";
import { scopePolicies, usePolicyCommands, usePolicyList } from "./state";
import { PluginNotice } from "../PluginsPage";
import { usePluginEnvironmentId } from "../pluginState";

const ENVIRONMENT_LABEL = "Environment";

/**
 * `/plugins/policy`: the policies of one scope on the primary environment, the environment
 * (`*`) or one of its projects, with the chosen policy's versions, the form for its next
 * version and where each agent stands. Built-in policies such as `ponytail` and `caveman` are
 * edited here like any other.
 */
export function PolicyScreen() {
  // Project ids belong to one environment, so the scope and selection start over with it.
  const environmentId = usePluginEnvironmentId();
  return <PolicyScreenContent key={environmentId ?? "none"} />;
}

function PolicyScreenContent() {
  const environmentId = usePluginEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [scope, setScope] = useState<ProjectId>(POLICY_ENVIRONMENT_PROJECT_ID);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = usePolicyList(scope);
  const { canWrite } = usePolicyCommands();
  // A failed re-read keeps the last data in `list.data`, so the error is checked first and the
  // screen never shows statuses that could not be re-read.
  const loaded = list.error === null && list.data !== null;
  const policies = useMemo(() => scopePolicies(list.data ?? [], scope), [list.data, scope]);
  const selected = policies.find((policy) => policy.key === selectedKey) ?? null;
  const scopeLabel =
    scope === POLICY_ENVIRONMENT_PROJECT_ID
      ? ENVIRONMENT_LABEL
      : (projects.find((project) => project.id === scope)?.title ?? scope);

  const pick = (next: ProjectId) => {
    setScope(next);
    setSelectedKey(null);
    setCreating(false);
  };
  const select = (key: string) => {
    setSelectedKey(key);
    setCreating(false);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Policies breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1 className="inline-flex items-center gap-1.5">
                <ScrollTextIcon className="size-4" />
                Policies
              </h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
              <Select
                value={scope}
                onValueChange={(value) => {
                  if (typeof value === "string") pick(value as ProjectId);
                }}
              >
                <SelectTrigger size="xs" variant="ghost" aria-label="Scope">
                  <SelectValue>{scopeLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={POLICY_ENVIRONMENT_PROJECT_ID}>{ENVIRONMENT_LABEL}</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || !loaded}
              onClick={() => {
                setSelectedKey(null);
                setCreating(true);
              }}
            >
              <PlusIcon />
              New policy
            </Button>
          </div>
        </WorkspacePageHeader>
        {list.error !== null ? (
          <PluginNotice>{list.error}</PluginNotice>
        ) : list.data === null ? null : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="wide">
              {policies.length === 0 && !creating ? (
                <PluginNotice>
                  {scope === POLICY_ENVIRONMENT_PROJECT_ID
                    ? "The environment has no policies."
                    : `${scopeLabel} has no policies of its own; the environment's apply to it.`}
                </PluginNotice>
              ) : (
                <PolicyList policies={policies} selectedKey={selectedKey} onSelect={select} />
              )}
              {creating ? (
                <NewPolicyForm
                  scope={scope}
                  existing={policies}
                  onCreated={(key) => {
                    list.refresh();
                    select(key);
                  }}
                  onCancel={() => setCreating(false)}
                />
              ) : selected === null ? null : (
                <>
                  <PolicyEditor
                    // The form starts from the body on show, so a new version on show remounts it.
                    key={`${scope}/${selected.key}/${selected.version}`}
                    scope={scope}
                    policy={selected}
                    onChanged={list.refresh}
                  />
                  <DeliveryStatus scope={scope} policy={selected} onChanged={list.refresh} />
                </>
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

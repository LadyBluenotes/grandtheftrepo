import { GraduationCapIcon } from "lucide-react";
import { useState } from "react";

import { useRelativeTimeTick } from "~/components/settings/settingsLayout";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
import { useProjects } from "~/state/entities";
import { CorrectionsTable } from "./CorrectionsTable";
import { DeterministicTable } from "./DeterministicTable";
import { ItemsTable } from "./ItemsTable";
import { usePrompt } from "./promptState";
import { PromptsTable } from "./PromptsTable";
import { ReviewsTable } from "./ReviewsTable";
import {
  followOpenItem,
  learningItemId,
  type LearningProjectChoice,
  NO_PROJECT_CHOICE,
  pluginActive,
  useLearningItem,
} from "./state";
import { PluginNotice } from "../PluginsPage";
import { usePluginScreenSearch } from "../pluginScreenSearch";
import { usePluginEnvironmentId, usePluginStatuses } from "../pluginState";

const TABS = ["items", "corrections", "prompts", "deterministic", "reviews"] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: unknown): value is Tab => (TABS as ReadonlyArray<unknown>).includes(value);

/**
 * `/plugins/learning`: one project's learning items, the corrections behind them, its prompt
 * library, its proposals to do repeated work without a model and, while the review plugin runs,
 * one thread's verdicts and requests. The tab and the open item or prompt, by `recordId`, are in
 * the URL. The project is the URL's `projectId`, else the environment's first, until a person
 * picks another, or an item or prompt the URL opens selects its own; picking one resets the tabs'
 * filters and the open record.
 */
export function LearningScreen() {
  const environmentId = usePluginEnvironmentId();
  const { statuses } = usePluginStatuses();
  const reviewsOn = pluginActive(statuses, "review");
  const search = usePluginScreenSearch();
  const tab: Tab = isTab(search.tab) ? search.tab : "items";
  const view: Tab = tab === "reviews" && !reviewsOn ? "items" : tab;
  // `recordId` is an item's id on the items tab and a prompt's on the prompts tab.
  const recordId = learningItemId(search.recordId);
  const openId = view === "items" ? recordId : null;
  const promptId = view === "prompts" ? recordId : null;
  const itemProjectId = useLearningItem(environmentId, openId).data?.item.projectId;
  const promptProjectId = usePrompt(environmentId, promptId).data?.prompt.projectId;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [choice, setChoice] = useState<LearningProjectChoice>({
    ...NO_PROJECT_CHOICE,
    projectId: search.projectId ?? null,
  });
  const followed = followOpenItem(choice, itemProjectId ?? promptProjectId);
  if (followed !== choice) setChoice(followed);
  const selected = projects.find((project) => project.id === followed.projectId) ?? projects[0];
  const openRecord = (id: number | null) => search.setRecordId(id === null ? null : String(id));
  useRelativeTimeTick(60_000);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Learning breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1 className="inline-flex items-center gap-1.5">
                <GraduationCapIcon className="size-4" />
                Learning
              </h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
              <Select<string>
                value={selected?.id ?? null}
                onValueChange={(value) => {
                  const next = projects.find((project) => project.id === value);
                  if (next === undefined) return;
                  setChoice({ ...followed, projectId: next.id });
                  if (search.recordId !== undefined) search.setRecordId(null);
                }}
              >
                <SelectTrigger size="xs" variant="ghost" aria-label="Project">
                  <SelectValue placeholder="No projects">{selected?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ml-auto">
            <ToggleGroup
              aria-label="View"
              value={[view]}
              onValueChange={(next) => {
                const value = next[0];
                if (isTab(value)) search.setTab(value);
              }}
            >
              <Toggle value="items">Items</Toggle>
              <Toggle value="corrections">Corrections</Toggle>
              <Toggle value="prompts">Prompts</Toggle>
              <Toggle value="deterministic">Deterministic</Toggle>
              {reviewsOn ? <Toggle value="reviews">Reviews</Toggle> : null}
            </ToggleGroup>
          </div>
        </WorkspacePageHeader>
        {environmentId === null || selected === undefined ? (
          <PluginNotice>Add a project to this environment to see what it learns.</PluginNotice>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="expanded">
              {view === "items" ? (
                <ItemsTable
                  environmentId={environmentId}
                  projectId={selected.id}
                  openId={openId}
                  onOpen={openRecord}
                />
              ) : view === "corrections" ? (
                <CorrectionsTable
                  key={`${environmentId}:${selected.id}`}
                  environmentId={environmentId}
                  projectId={selected.id}
                />
              ) : view === "prompts" ? (
                <PromptsTable
                  key={`${environmentId}:${selected.id}`}
                  environmentId={environmentId}
                  projectId={selected.id}
                  openId={promptId}
                  onOpen={openRecord}
                />
              ) : view === "deterministic" ? (
                <DeterministicTable
                  key={`${environmentId}:${selected.id}`}
                  environmentId={environmentId}
                  projectId={selected.id}
                />
              ) : (
                <ReviewsTable
                  key={`${environmentId}:${selected.id}`}
                  environmentId={environmentId}
                  projectId={selected.id}
                />
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { knowledgePagePath, type KnowledgeEntry, type ProjectId } from "@t3tools/contracts";
import { BookOpenTextIcon } from "lucide-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useProjects } from "~/state/entities";
import { PluginNotice } from "../PluginsPage";
import { usePluginEnvironmentId } from "../pluginState";
import {
  AGENT_LABEL,
  acceptInput,
  canRestore,
  deliveryBadge,
  draftProblem,
  groupKnowledge,
  needsInstall,
  useKnowledgeCommands,
  useKnowledgeDelivery,
  useKnowledgeEntries,
} from "./state";

/**
 * `/plugins/knowledge`: one project's knowledge pages on the plugin environment. Drafts are
 * accepted or discarded, accepted pages retired, retired ones proposed again, and the delivery
 * to each agent's instruction file reinstalled. Both lists reread after every command, whatever
 * its outcome: an accept or retire stands even when the install after it fails.
 */
export default function KnowledgePage() {
  const environmentId = usePluginEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [chosen, setChosen] = useState<ProjectId | null>(null);
  const project = projects.find((candidate) => candidate.id === chosen) ?? projects[0];
  const projectId = project?.id ?? null;

  const entries = useKnowledgeEntries(projectId);
  const delivery = useKnowledgeDelivery(projectId);
  const commands = useKnowledgeCommands();
  const [busy, setBusy] = useState(false);
  const locked = busy || entries.isPending || delivery.isPending;

  const run = async (
    failureTitle: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    entries.refresh();
    delivery.refresh();
    setBusy(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  const groups = groupKnowledge(entries.data ?? []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Knowledge breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1 className="inline-flex items-center gap-1.5">
                <BookOpenTextIcon className="size-4" />
                Knowledge
              </h1>
            </WorkspaceBreadcrumbItem>
            {project === undefined ? null : (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
                  <Select
                    value={project.id}
                    onValueChange={(value) => {
                      if (typeof value === "string") setChosen(value as ProjectId);
                    }}
                  >
                    <SelectTrigger size="xs" variant="ghost" aria-label="Project">
                      <SelectValue>{project.title}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {projectId === null ? (
          <PluginNotice>This environment has no projects.</PluginNotice>
        ) : entries.error !== null ? (
          <PluginNotice>{entries.error}</PluginNotice>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer>
              <SettingsSection
                title="Delivery"
                headerAction={
                  <Button
                    size="xs"
                    variant={needsInstall(delivery.data ?? []) ? "default" : "outline"}
                    disabled={locked || !commands.canWrite}
                    onClick={() =>
                      void run("Could not reinstall the pages", () => commands.install(projectId))
                    }
                  >
                    Reinstall
                  </Button>
                }
              >
                {delivery.error !== null ? (
                  <SettingsRow title="Delivery is unknown" description={delivery.error} />
                ) : (delivery.data ?? []).length === 0 ? (
                  <SettingsRow
                    title="No agent in use"
                    description="Pages are written for Claude Code, Codex and Copilot once one of them is set up on the server's machine."
                  />
                ) : (
                  (delivery.data ?? []).map((result) => {
                    const badge = deliveryBadge(result.status);
                    return (
                      <SettingsRow
                        key={result.agent}
                        title={AGENT_LABEL[result.agent]}
                        description={result.path}
                        status={
                          <Badge size="sm" variant={badge.variant}>
                            {badge.label}
                          </Badge>
                        }
                      />
                    );
                  })
                )}
              </SettingsSection>

              <SettingsSection title="Drafts">
                {groups.drafts.length === 0 ? (
                  <SettingsRow
                    title="No drafts"
                    description="Agents propose pages with the knowledge_propose tool. A draft is not written to the project until you accept it."
                  />
                ) : (
                  groups.drafts.map((draft) => (
                    <DraftRow
                      // A numeric id repeats across environments; the edits belong to one draft.
                      key={`${environmentId}:${draft.id}`}
                      draft={draft}
                      locked={locked || !commands.canWrite}
                      onAccept={(title, body) =>
                        void run("Could not accept the page", () =>
                          commands.accept(acceptInput(draft, title, body)),
                        )
                      }
                      onDiscard={() =>
                        void run("Could not discard the draft", () => commands.discard(draft.id))
                      }
                    />
                  ))
                )}
              </SettingsSection>

              <SettingsSection title="Pages">
                {groups.accepted.length === 0 ? (
                  <SettingsRow
                    title="No pages"
                    description="Accepted pages are written to the project's .knowledge directory and listed in each agent's instruction file."
                  />
                ) : (
                  groups.accepted.map((page) => (
                    <SettingsRow
                      key={page.id}
                      title={page.title}
                      description={knowledgePagePath(page.key)}
                      control={
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={locked || !commands.canWrite}
                          onClick={() =>
                            void run("Could not retire the page", () => commands.retire(page.id))
                          }
                        >
                          Retire
                        </Button>
                      }
                    />
                  ))
                )}
              </SettingsSection>

              {groups.retired.length === 0 ? null : (
                <SettingsSection title="Retired">
                  {groups.retired.map((page) => (
                    <RetiredRow
                      key={page.id}
                      page={page}
                      locked={locked || !commands.canPropose}
                      onRestore={
                        canRestore(page, groups)
                          ? () =>
                              void run("Could not restore the page", () => commands.restore(page))
                          : undefined
                      }
                    />
                  ))}
                </SettingsSection>
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

/** A draft with its title and body editable; accepting sends only what changed. */
function DraftRow({
  draft,
  locked,
  onAccept,
  onDiscard,
}: {
  readonly draft: KnowledgeEntry;
  readonly locked: boolean;
  readonly onAccept: (title: string, body: string) => void;
  readonly onDiscard: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const problem = draftProblem(title, body);
  return (
    <SettingsRow
      title={knowledgePagePath(draft.key)}
      description={draft.source.kind === "agent" ? "Proposed by an agent" : "Proposed by a person"}
      control={
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            size="xs"
            disabled={locked || problem !== null}
            onClick={() => onAccept(title, body)}
          >
            Accept
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 pb-3">
        <Input
          size="sm"
          aria-label={`Title of ${draft.key}`}
          value={title}
          disabled={locked}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          rows={6}
          aria-label={`Body of ${draft.key}`}
          value={body}
          disabled={locked}
          onChange={(event) => setBody(event.target.value)}
        />
        {problem === null ? null : <p className="text-xs text-destructive">{problem}</p>}
      </div>
    </SettingsRow>
  );
}

/**
 * A retired page or discarded draft. Restoring proposes it again as a draft; there is no
 * `onRestore` while a draft or accepted page holds its key.
 */
function RetiredRow({
  page,
  locked,
  onRestore,
}: {
  readonly page: KnowledgeEntry;
  readonly locked: boolean;
  readonly onRestore: (() => void) | undefined;
}) {
  return (
    <SettingsRow
      title={page.title}
      description={knowledgePagePath(page.key)}
      control={
        onRestore === undefined ? undefined : (
          <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onRestore}>
            Restore as draft
          </Button>
        )
      }
    />
  );
}

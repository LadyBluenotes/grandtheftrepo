import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  KANBAN_STATUSES,
  type EnvironmentId,
  type KanbanIssueSummary,
  type KanbanStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  FolderIcon,
  GitBranchIcon,
  OctagonAlertIcon,
  PlusIcon,
  ScaleIcon,
  SquareKanbanIcon,
  UserRoundCheckIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type CSSProperties, type FormEvent } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { isElectron } from "~/env";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { DecisionsView } from "./DecisionsView";
import { IssuePanel } from "./IssuePanel";
import { ReopenDialog } from "./ReopenDialog";
import { StopBanner } from "./StopBanner";
import { kanbanActiveAtom, kanbanBoard, kanbanSetDirectory, kanbanWrite } from "./state";

export interface BoardSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly issue?: string;
  readonly view?: "decisions";
  readonly category?: string;
  readonly needsYou?: true;
  readonly archived?: true;
}

export const STATUS_LABEL: Record<KanbanStatus, string> = {
  triage: "Triage",
  inbox: "Inbox",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

const LAST_PROJECT_KEY = "t3code:kanban:last-project";

function readLastProject(): { environmentId: EnvironmentId; projectId: ProjectId } | null {
  try {
    const raw = window.localStorage.getItem(LAST_PROJECT_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null &&
      typeof parsed === "object" &&
      "environmentId" in parsed &&
      "projectId" in parsed &&
      typeof parsed.environmentId === "string" &&
      typeof parsed.projectId === "string"
      ? {
          environmentId: parsed.environmentId as EnvironmentId,
          projectId: parsed.projectId as ProjectId,
        }
      : null;
  } catch {
    return null;
  }
}

/** A stable hue per label name, fed to the badge's `--label` color. */
export function labelColor(label: string): CSSProperties {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { "--label": `oklch(0.7 0.15 ${hash % 360})` } as CSSProperties;
}

export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );
}

const PRIORITY_VARIANT: Record<KanbanIssueSummary["priority"], "error" | "warning" | "secondary"> =
  {
    p0: "error",
    p1: "error",
    p2: "warning",
    p3: "secondary",
    p4: "secondary",
    p5: "secondary",
  };

const Card = memo(function Card({
  issue,
  onOpen,
}: {
  readonly issue: KanbanIssueSummary;
  readonly onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.id,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={cn(
        "flex w-full cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-left text-sm text-card-foreground shadow-xs hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
      style={{ transform: CSS.Translate.toString(transform) }}
      onClick={() => onOpen(issue.id)}
      {...listeners}
      {...attributes}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 leading-snug">{issue.title}</span>
        {issue.blocked !== null ? (
          <OctagonAlertIcon className="size-4 shrink-0 text-destructive" aria-label="Needs you" />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Badge size="sm" variant={PRIORITY_VARIANT[issue.priority]}>
          {issue.priority.toUpperCase()}
        </Badge>
        {issue.verification !== "unverified" ? (
          <Badge size="sm" variant={issue.verification === "verified" ? "success" : "info"}>
            {issue.verification}
          </Badge>
        ) : null}
        {issue.tier !== null ? (
          <Badge size="sm" variant="outline">
            {issue.tier}
          </Badge>
        ) : null}
        {issue.criteriaTotal > 0 ? (
          <Badge size="sm" variant={issue.criteriaOpen === 0 ? "success" : "outline"}>
            {issue.criteriaTotal - issue.criteriaOpen}/{issue.criteriaTotal}
          </Badge>
        ) : null}
        {issue.labels.map((label) => (
          <Badge key={label} size="sm" variant="label" style={labelColor(label)}>
            {label}
          </Badge>
        ))}
        {issue.threads.length > 0 ? (
          <span className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3" />
            {issue.threads.length}
          </span>
        ) : null}
      </div>
    </button>
  );
});

function Column({
  status,
  issues,
  onOpen,
  onCreate,
}: {
  readonly status: KanbanStatus;
  readonly issues: ReadonlyArray<KanbanIssueSummary>;
  readonly onOpen: (id: string) => void;
  readonly onCreate: (status: KanbanStatus, title: string) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    await onCreate(status, trimmed);
    setTitle("");
    setAdding(false);
  };
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/30",
        isOver && "border-ring bg-accent/40",
      )}
      aria-label={STATUS_LABEL[status]}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <h2 className="text-sm font-medium">{STATUS_LABEL[status]}</h2>
        <span className="text-xs text-muted-foreground">{issues.length}</span>
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New issue in ${STATUS_LABEL[status]}`}
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-2 pb-2">
          {adding ? (
            <form onSubmit={submit}>
              <Input
                autoFocus
                size="sm"
                placeholder="Issue title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => title.trim().length === 0 && setAdding(false)}
                onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
              />
            </form>
          ) : null}
          {issues.map((issue) => (
            <Card key={issue.id} issue={issue} onOpen={onOpen} />
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

const byPriorityThenAge = (a: KanbanIssueSummary, b: KanbanIssueSummary) =>
  a.priority.localeCompare(b.priority) || a.createdAt.localeCompare(b.createdAt);

export function BoardPage({ search }: { readonly search: BoardSearch }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const selected = useMemo(() => {
    const fromSearch =
      search.environmentId !== undefined && search.projectId !== undefined
        ? projects.find(
            (p) => p.environmentId === search.environmentId && p.id === search.projectId,
          )
        : undefined;
    if (fromSearch !== undefined) return fromSearch;
    const remembered = readLastProject();
    return (
      projects.find(
        (p) => p.environmentId === remembered?.environmentId && p.id === remembered?.projectId,
      ) ?? projects[0]
    );
  }, [projects, search.environmentId, search.projectId]);
  const environmentId = selected?.environmentId ?? null;
  const projectId = selected?.id ?? null;
  const active = useAtomValue(kanbanActiveAtom(environmentId ?? ("" as EnvironmentId)));

  const setSearch = useCallback(
    (
      patch: { readonly [K in keyof BoardSearch]?: BoardSearch[K] | undefined },
      options?: { readonly replace?: boolean },
    ) =>
      navigate({
        to: "/board",
        search: (previous: BoardSearch) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next as BoardSearch;
        },
        ...(options?.replace === true ? { replace: true } : {}),
      }),
    [navigate],
  );
  const closePanel = useCallback(() => setSearch({ issue: undefined }), [setSearch]);
  useEscapeToGoBack(search.issue === undefined ? undefined : closePanel);

  const board = useEnvironmentQuery(
    environmentId !== null && projectId !== null && active === true
      ? kanbanBoard({ environmentId, input: { projectId } })
      : null,
  );
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const setDirectory = useAtomCommand(kanbanSetDirectory, { reportFailure: false });
  const canWrite = useAtomValue(kanbanWrite.permissionAtom(environmentId));

  const columns = useMemo(() => {
    const grouped = new Map<KanbanStatus, Array<KanbanIssueSummary>>(
      KANBAN_STATUSES.map((status) => [status, []]),
    );
    for (const issue of board.data?.issues ?? []) {
      if (issue.archivedAt !== null && search.archived !== true) continue;
      if (search.needsYou === true && issue.blocked === null) continue;
      grouped.get(issue.status)?.push(issue);
    }
    for (const list of grouped.values()) list.sort(byPriorityThenAge);
    return grouped;
  }, [board.data, search.archived, search.needsYou]);
  const needsYouCount = useMemo(
    () =>
      (board.data?.issues ?? []).filter((i) => i.blocked !== null && i.archivedAt === null).length,
    [board.data],
  );

  const [reopen, setReopen] = useState<{ id: string; status: KanbanStatus } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (environmentId === null || projectId === null || event.over === null) return;
      const status = event.over.id as KanbanStatus;
      const id = String(event.active.id);
      const from = board.data?.issues.find((issue) => issue.id === id)?.status;
      if (from === status) return;
      if (from === "done") {
        setReopen({ id, status });
        return;
      }
      reportFailure(
        "Could not move the issue",
        await write({ environmentId, input: { projectId, action: "issue.move", id, status } }),
      );
    },
    [board.data, environmentId, projectId, write],
  );
  const onCreate = useCallback(
    async (status: KanbanStatus, title: string) => {
      if (environmentId === null || projectId === null) return;
      reportFailure(
        "Could not create the issue",
        await write({ environmentId, input: { projectId, action: "issue.create", title, status } }),
      );
    },
    [environmentId, projectId, write],
  );
  const openIssue = useCallback((id: string) => void setSearch({ issue: id }), [setSearch]);

  const [directoryDraft, setDirectoryDraft] = useState<string | null>(null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <h1 className="inline-flex items-center gap-1.5">
                <SquareKanbanIcon className="size-4" />
                Board
              </h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
              <Select
                value={
                  selected === undefined ? null : `${selected.environmentId}\u0000${selected.id}`
                }
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  const [env, id] = value.split("\u0000");
                  const next = { environmentId: env as EnvironmentId, projectId: id as ProjectId };
                  try {
                    window.localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(next));
                  } catch {
                    // Remembering the project is a convenience; the URL still carries it.
                  }
                  void setSearch({ ...next, issue: undefined, category: undefined });
                }}
              >
                <SelectTrigger size="xs" variant="ghost" aria-label="Project">
                  <SelectValue placeholder="Pick a project">{selected?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}\u0000${project.id}`}
                    >
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ml-auto flex items-center gap-1.5">
            <Toggle
              size="sm"
              variant="outline"
              pressed={search.needsYou === true}
              onPressedChange={(pressed) =>
                void setSearch({ needsYou: pressed ? true : undefined })
              }
              aria-label="Only issues that need you"
            >
              <UserRoundCheckIcon />
              Needs you{needsYouCount > 0 ? ` (${needsYouCount})` : ""}
            </Toggle>
            <Toggle
              size="sm"
              variant="outline"
              pressed={search.archived === true}
              onPressedChange={(pressed) =>
                void setSearch({ archived: pressed ? true : undefined })
              }
              aria-label="Show archived issues"
            >
              <ArchiveIcon />
              Archived
            </Toggle>
            <Toggle
              size="sm"
              variant="outline"
              pressed={search.view === "decisions"}
              onPressedChange={(pressed) =>
                void setSearch({ view: pressed ? "decisions" : undefined, issue: undefined })
              }
              aria-label="Show decisions"
            >
              <ScaleIcon />
              Decisions
            </Toggle>
            <Popover
              onOpenChange={(open) => open && setDirectoryDraft(board.data?.directory ?? "")}
            >
              <PopoverTrigger
                render={<Button size="icon-sm" variant="ghost-muted" aria-label="Issues folder" />}
              >
                <FolderIcon />
              </PopoverTrigger>
              <PopoverPopup side="bottom" align="end" className="w-96">
                <form
                  className="flex flex-col gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (environmentId === null || projectId === null) return;
                    const directory = (directoryDraft ?? "").trim();
                    reportFailure(
                      "Could not change the folder",
                      await setDirectory({
                        environmentId,
                        input: { projectId, directory: directory.length === 0 ? null : directory },
                      }),
                    );
                  }}
                >
                  <p className="text-xs text-muted-foreground">
                    Issues and decisions live as files in this folder on the environment. Leave it
                    empty to use the default under the T3 home.
                  </p>
                  <Input
                    size="sm"
                    value={directoryDraft ?? ""}
                    onChange={(event) => setDirectoryDraft(event.target.value)}
                    placeholder={board.data?.directory}
                    spellCheck={false}
                  />
                  <div className="flex justify-end gap-2">
                    <Button type="submit" size="xs" disabled={!canWrite}>
                      Save
                    </Button>
                  </div>
                </form>
              </PopoverPopup>
            </Popover>
          </div>
        </WorkspacePageHeader>

        {environmentId !== null && active === true ? (
          <StopBanner environmentId={environmentId} />
        ) : null}

        {selected === undefined ? (
          <Empty className="m-auto">
            <EmptyHeader>
              <EmptyTitle>No project</EmptyTitle>
              <EmptyDescription>Add a project to start a board for it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : active === false ? (
          <Empty className="m-auto">
            <EmptyHeader>
              <EmptyTitle>Kanban is off on this environment</EmptyTitle>
              <EmptyDescription>
                Enable the <code>kanban</code> plugin in that server&apos;s plugins.json and restart
                it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : board.error !== null ? (
          <Empty className="m-auto">
            <EmptyHeader>
              <EmptyTitle>Could not load the board</EmptyTitle>
              <EmptyDescription>{board.error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : search.view === "decisions" && environmentId !== null && projectId !== null ? (
          <DecisionsView
            environmentId={environmentId}
            projectId={projectId}
            category={search.category}
            categories={board.data?.decisionCategories ?? []}
            onCategoryChange={(category) => void setSearch({ category })}
            canWrite={canWrite}
          />
        ) : (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pt-4 pb-5 sm:px-6">
              {KANBAN_STATUSES.map((status) => (
                <Column
                  key={status}
                  status={status}
                  issues={columns.get(status) ?? []}
                  onOpen={openIssue}
                  onCreate={onCreate}
                />
              ))}
            </div>
          </DndContext>
        )}
      </div>
      <ReopenDialog
        open={reopen !== null}
        onCancel={() => setReopen(null)}
        onPick={async (reason) => {
          const target = reopen;
          setReopen(null);
          if (target === null || environmentId === null || projectId === null) return;
          reportFailure(
            "Could not reopen the issue",
            await write({
              environmentId,
              input: {
                projectId,
                action: "issue.move",
                id: target.id,
                status: target.status,
                reopenReason: reason,
              },
            }),
          );
        }}
      />
      {environmentId !== null && projectId !== null ? (
        <IssuePanel
          environmentId={environmentId}
          projectId={projectId}
          issueId={search.issue ?? null}
          categories={board.data?.decisionCategories ?? []}
          canWrite={canWrite}
          onClose={closePanel}
        />
      ) : null}
    </SidebarInset>
  );
}

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
import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
  type ScopedProjectRef,
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
import { useClientSettings } from "~/hooks/useSettings";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { selectProjectGroupingSettings } from "~/logicalProject";
import { cn } from "~/lib/utils";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { AttentionStrip } from "./AttentionStrip";
import {
  boardFanOut,
  boardFolder,
  boardProjectKey,
  decisionsCategory,
  pickBoardProject,
  scopedBoardProjects,
  type BoardEnvironment,
  type BoardProject,
} from "./boardScope";
import { DecisionsView } from "./DecisionsView";
import { IssuePanel } from "./IssuePanel";
import { ProjectSelect } from "./ProjectSelect";
import { ReopenDialog } from "./ReopenDialog";
import { StopBanner } from "./StopBanner";
import {
  kanbanBoardAttention,
  kanbanBoardEnvironments,
  kanbanBoards,
  kanbanBoardsChanged,
  kanbanSetDirectory,
  kanbanWrite,
} from "./state";

export interface BoardSearch {
  /**
   * With `projectId`, the project in hand: the open issue's, the decisions view's, and the default
   * for a new card. Which projects the board shows is the sidebar's project scope.
   */
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  /** The open issue's slug, unique only within the project above. */
  readonly issue?: string;
  readonly view?: "decisions";
  /** The decisions view's category, in the project above. */
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

/** The project a card was last filed in or picked for; what asks for a project defaults to it. */
const LAST_PROJECT_KEY = "t3code:kanban:last-project";

function readLastProject(): ScopedProjectRef | null {
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

/** A card on the board with the project it lives in: slugs are unique per project only. */
interface BoardCard extends ScopedProjectRef {
  readonly key: string;
  readonly issue: KanbanIssueSummary;
}

const sameProject = (left: ScopedProjectRef) => (right: ScopedProjectRef) =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

const cardKey = (ref: ScopedProjectRef, id: string) =>
  `${ref.environmentId}\u0000${ref.projectId}\u0000${id}`;

// Props stay the board's own objects and strings, so a change in one project's board leaves the
// other projects' cards as they were.
const Card = memo(function Card({
  issue,
  environmentId,
  projectId,
  place,
  onOpen,
}: ScopedProjectRef & {
  readonly issue: KanbanIssueSummary;
  /** The card's project, while the board shows more than one. */
  readonly place: string | null;
  readonly onOpen: (ref: ScopedProjectRef, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardKey({ environmentId, projectId }, issue.id),
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
      onClick={() => onOpen({ environmentId, projectId }, issue.id)}
      {...listeners}
      {...attributes}
    >
      {place === null ? null : (
        <span className="truncate text-xs text-muted-foreground">{place}</span>
      )}
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
  cards,
  places,
  projects,
  defaultProject,
  onOpen,
  onCreate,
}: {
  readonly status: KanbanStatus;
  readonly cards: ReadonlyArray<BoardCard>;
  readonly places: ReadonlyMap<string, string> | null;
  /** Where a new card can go; asked for when there is more than one. */
  readonly projects: ReadonlyArray<BoardProject>;
  readonly defaultProject: BoardProject | null;
  readonly onOpen: (ref: ScopedProjectRef, id: string) => void;
  readonly onCreate: (status: KanbanStatus, title: string, project: BoardProject) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<BoardProject | null>(null);
  const project = picked ?? defaultProject;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0 || project === null) return;
    await onCreate(status, trimmed, project);
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
        <span className="text-xs text-muted-foreground">{cards.length}</span>
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New issue in ${STATUS_LABEL[status]}`}
          disabled={defaultProject === null}
          onClick={() => {
            setPicked(null);
            setAdding(true);
          }}
        >
          <PlusIcon />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-2 pb-2">
          {adding ? (
            <form className="flex flex-col gap-1.5" onSubmit={submit}>
              <Input
                autoFocus
                size="sm"
                placeholder="Issue title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={(event) => {
                  // Picking the project moves focus to its select without leaving the form.
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.form?.contains(next)) return;
                  if (title.trim().length === 0) setAdding(false);
                }}
                onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
              />
              {projects.length > 1 ? (
                // The select's own hidden input would stop Enter submitting a form with no button.
                <div className="flex items-center gap-1.5">
                  <ProjectSelect
                    className="min-w-0 flex-1"
                    projects={projects}
                    value={project}
                    onChange={setPicked}
                  />
                  <Button type="submit" size="sm" disabled={title.trim().length === 0}>
                    Add
                  </Button>
                </div>
              ) : null}
            </form>
          ) : null}
          {cards.map((card) => (
            <Card
              key={card.key}
              issue={card.issue}
              environmentId={card.environmentId}
              projectId={card.projectId}
              place={places?.get(boardProjectKey(card)) ?? null}
              onOpen={onOpen}
            />
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

/**
 * The issues folder of one project, which the board can change. Over several projects it asks
 * which, starting from the project in hand. A project's folder is read without loading its board,
 * and saving waits until it is known, so an unread folder is never saved back as the default.
 */
function FolderPopover({
  projects,
  defaultProject,
  environments,
  onSaved,
}: {
  readonly projects: ReadonlyArray<BoardProject>;
  readonly defaultProject: BoardProject | null;
  readonly environments: ReadonlyArray<BoardEnvironment>;
  readonly onSaved: () => void;
}) {
  const setDirectory = useAtomCommand(kanbanSetDirectory, { reportFailure: false });
  const [picked, setPicked] = useState<BoardProject | null>(null);
  // Null until edited: the field shows the project's folder as last read.
  const [draft, setDraft] = useState<string | null>(null);
  const project = picked ?? defaultProject;
  const canSave = useAtomValue(kanbanSetDirectory.permissionAtom(project?.environmentId ?? null));
  const current = project === null ? undefined : boardFolder(environments, project)?.directory;
  const value = draft ?? current ?? "";
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        setPicked(null);
        setDraft(null);
      }}
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
            if (project === null || current === undefined) return;
            const directory = value.trim();
            const result = await setDirectory({
              environmentId: project.environmentId,
              input: {
                projectId: project.projectId,
                directory: directory.length === 0 ? null : directory,
              },
            });
            reportFailure("Could not change the folder", result);
            if (result._tag === "Success") onSaved();
          }}
        >
          <p className="text-xs text-muted-foreground">
            Issues and decisions live as files in this folder on the environment. Leave it empty to
            use the default under the T3 home.
          </p>
          {projects.length > 1 ? (
            <ProjectSelect
              projects={projects}
              value={project}
              onChange={(next) => {
                setPicked(next);
                setDraft(null);
              }}
            />
          ) : null}
          <Input
            size="sm"
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={current}
            spellCheck={false}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="submit"
              size="xs"
              disabled={!canSave || project === null || current === undefined}
            >
              Save
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

const byPriorityThenAge = ({ issue: a }: BoardCard, { issue: b }: BoardCard) =>
  a.priority.localeCompare(b.priority) || a.createdAt.localeCompare(b.createdAt);

const ALL_PROJECTS = "all";

/** The sidebar's project groups, built as the sidebar builds them so its scope keys match. */
function useBoardProjectGroups() {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const environmentLabels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    const groups = buildSidebarProjectSnapshots({
      projects,
      settings,
      groupScratchProjects: true,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => environmentLabels.get(id) ?? null,
    }).toSorted((a, b) => a.displayName.localeCompare(b.displayName));
    return { groups, settings, environmentLabels, projects };
  }, [environments, primaryEnvironmentId, projects, settings]);
}

export function BoardPage({ search }: { readonly search: BoardSearch }) {
  const navigate = useNavigate();
  const { groups, settings, environmentLabels, projects } = useBoardProjectGroups();
  const persistedScope = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setScope = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const scopeKey = useMemo(
    () => resolveSidebarProjectScopeKey({ groups, key: persistedScope, settings }),
    [groups, persistedScope, settings],
  );
  const scopedGroup = groups.find((group) => group.projectKey === scopeKey) ?? null;
  const scoped = useMemo(
    () => scopedBoardProjects(groups, scopeKey, projects),
    [groups, projects, scopeKey],
  );
  const environments = useAtomValue(kanbanBoardEnvironments(scoped));
  const { writable, shown } = useMemo(
    () => boardFanOut(scoped, environments),
    [scoped, environments],
  );
  const boards = useAtomValue(kanbanBoards(shown));
  // Every project the board can write to, board or not: their requests and an environment's
  // policy flag wait on a person all the same.
  const attention = useAtomValue(kanbanBoardAttention(writable));
  const labels = useMemo(
    () => new Map(scoped.map((project) => [boardProjectKey(project), project.label] as const)),
    [scoped],
  );
  const projectLabel = useCallback(
    (ref: ScopedProjectRef) => labels.get(boardProjectKey(ref)),
    [labels],
  );

  const [lastUsed, setLastUsed] = useState(readLastProject);
  const remember = useCallback((project: ScopedProjectRef) => {
    const ref = { environmentId: project.environmentId, projectId: project.projectId };
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(ref));
    } catch {
      // Remembering the project is a convenience; the select still shows the one in use.
    }
    setLastUsed(ref);
  }, []);
  const inHand =
    search.environmentId !== undefined && search.projectId !== undefined
      ? { environmentId: search.environmentId, projectId: search.projectId }
      : null;
  const newCardProject = pickBoardProject(writable, inHand, lastUsed);
  const viewProject = pickBoardProject(shown, inHand, lastUsed);
  // The open issue is in the URL's project even outside the scope; the panel stays mounted to close.
  const panelProject = inHand ?? viewProject;
  const canWritePanel = useAtomValue(
    kanbanWrite.permissionAtom(panelProject?.environmentId ?? null),
  );
  const canWriteView = useAtomValue(kanbanWrite.permissionAtom(viewProject?.environmentId ?? null));
  const boardOf = (ref: ScopedProjectRef | null) =>
    ref === null ? undefined : (boards.find(sameProject(ref))?.board ?? undefined);

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

  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const bumpBoards = useAtomSet(kanbanBoardsChanged);
  const boardsChanged = useCallback(() => bumpBoards((count) => count + 1), [bumpBoards]);

  const cards = useMemo(
    () =>
      boards.flatMap(({ environmentId, projectId, board }) =>
        (board?.issues ?? []).map((issue): BoardCard => ({
          key: cardKey({ environmentId, projectId }, issue.id),
          environmentId,
          projectId,
          issue,
        })),
      ),
    [boards],
  );
  const columns = useMemo(() => {
    const grouped = new Map<KanbanStatus, Array<BoardCard>>(
      KANBAN_STATUSES.map((status) => [status, []]),
    );
    for (const card of cards) {
      if (card.issue.archivedAt !== null && search.archived !== true) continue;
      if (search.needsYou === true && card.issue.blocked === null) continue;
      grouped.get(card.issue.status)?.push(card);
    }
    for (const list of grouped.values()) list.sort(byPriorityThenAge);
    return grouped;
  }, [cards, search.archived, search.needsYou]);
  const needsYouCount = useMemo(
    () => cards.filter(({ issue }) => issue.blocked !== null && issue.archivedAt === null).length,
    [cards],
  );

  const [reopen, setReopen] = useState<{ card: BoardCard; status: KanbanStatus } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (event.over === null) return;
      const status = event.over.id as KanbanStatus;
      const card = cards.find((candidate) => candidate.key === String(event.active.id));
      if (card === undefined || card.issue.status === status) return;
      if (card.issue.status === "done") {
        setReopen({ card, status });
        return;
      }
      reportFailure(
        "Could not move the issue",
        await write({
          environmentId: card.environmentId,
          input: { projectId: card.projectId, action: "issue.move", id: card.issue.id, status },
        }),
      );
    },
    [cards, setReopen, write],
  );
  const onCreate = useCallback(
    async (status: KanbanStatus, title: string, project: BoardProject) => {
      remember(project);
      const result = await write({
        environmentId: project.environmentId,
        input: { projectId: project.projectId, action: "issue.create", title, status },
      });
      reportFailure("Could not create the issue", result);
      // A project's first card starts its board, which the board then has to subscribe to.
      if (result._tag === "Success" && !shown.some(sameProject(project))) boardsChanged();
    },
    [boardsChanged, remember, shown, write],
  );
  const openIssue = useCallback(
    ({ environmentId, projectId }: ScopedProjectRef, id: string) =>
      void setSearch({ environmentId, projectId, issue: id }),
    [setSearch],
  );

  // Cards say which project they are in once the scope covers more than one.
  const places = scoped.length > 1 ? labels : null;
  const showsEnvironments = environments.length > 1;
  const off = environments.filter((environment) => environment.active === false);
  const notices = [
    ...(off.length === 0 || off.length === environments.length
      ? []
      : [
          `Kanban is off on ${off.map((e) => environmentLabels.get(e.environmentId) ?? e.environmentId).join(", ")}, so the board leaves out ${off.length === 1 ? "its" : "their"} projects.`,
        ]),
    ...environments.flatMap((environment) =>
      environment.error === null
        ? []
        : [
            `Could not read the boards on ${environmentLabels.get(environment.environmentId) ?? environment.environmentId}: ${environment.error}`,
          ],
    ),
    ...boards.flatMap((board) =>
      board.error === null
        ? []
        : [`Could not load the board of ${projectLabel(board) ?? board.projectId}: ${board.error}`],
    ),
  ];

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
                value={scopedGroup?.projectKey ?? ALL_PROJECTS}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  // The sidebar's scope: the thread list follows, and the choice persists.
                  setScope(value === ALL_PROJECTS ? null : value);
                  void setSearch({
                    environmentId: undefined,
                    projectId: undefined,
                    issue: undefined,
                    category: undefined,
                  });
                }}
              >
                <SelectTrigger size="xs" variant="ghost" aria-label="Project">
                  <SelectValue>{scopedGroup?.displayName ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.projectKey} value={group.projectKey}>
                      {group.displayName}
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
            <FolderPopover
              projects={writable}
              defaultProject={newCardProject}
              environments={environments}
              onSaved={boardsChanged}
            />
          </div>
        </WorkspacePageHeader>

        {environments.map((environment) =>
          environment.active === true ? (
            <StopBanner
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={
                showsEnvironments
                  ? (environmentLabels.get(environment.environmentId) ?? null)
                  : null
              }
            />
          ) : null,
        )}
        {notices.length > 0 ? (
          <div className="flex flex-col gap-0.5 px-5 pt-3 text-xs text-muted-foreground sm:px-6">
            {notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </div>
        ) : null}

        {groups.length === 0 ? (
          <Empty className="m-auto">
            <EmptyHeader>
              <EmptyTitle>No project</EmptyTitle>
              <EmptyDescription>Add a project to start a board for it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environments.length > 0 && off.length === environments.length ? (
          <Empty className="m-auto">
            <EmptyHeader>
              <EmptyTitle>
                Kanban is off on {off.length === 1 ? "this environment" : "these environments"}
              </EmptyTitle>
              <EmptyDescription>
                Enable the <code>kanban</code> plugin in{" "}
                {off.length === 1 ? "that server's" : "each server's"} plugins.json and restart it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : search.view === "decisions" ? (
          viewProject === null ? (
            <Empty className="m-auto">
              <EmptyHeader>
                <EmptyTitle>No board yet</EmptyTitle>
                <EmptyDescription>
                  Add a card to a project to start its board and record its decisions.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <DecisionsView
              key={boardProjectKey(viewProject)}
              environmentId={viewProject.environmentId}
              projectId={viewProject.projectId}
              category={decisionsCategory(search, viewProject)}
              categories={boardOf(viewProject)?.decisionCategories ?? []}
              onCategoryChange={(category) =>
                void setSearch({
                  environmentId: viewProject.environmentId,
                  projectId: viewProject.projectId,
                  category,
                })
              }
              canWrite={canWriteView}
              projectSelect={
                shown.length > 1 ? (
                  <ProjectSelect
                    className="w-56 min-w-0"
                    projects={shown}
                    value={viewProject}
                    onChange={(project) => {
                      remember(project);
                      void setSearch({
                        environmentId: project.environmentId,
                        projectId: project.projectId,
                        category: undefined,
                      });
                    }}
                  />
                ) : null
              }
            />
          )
        ) : (
          <>
            <AttentionStrip rows={attention} projectLabel={projectLabel} />
            <DndContext sensors={sensors} onDragEnd={onDragEnd}>
              <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pt-4 pb-5 sm:px-6">
                {KANBAN_STATUSES.map((status) => (
                  <Column
                    key={status}
                    status={status}
                    cards={columns.get(status) ?? []}
                    places={places}
                    projects={writable}
                    defaultProject={newCardProject}
                    onOpen={openIssue}
                    onCreate={onCreate}
                  />
                ))}
              </div>
            </DndContext>
          </>
        )}
      </div>
      <ReopenDialog
        open={reopen !== null}
        onCancel={() => setReopen(null)}
        onPick={async (reason) => {
          const target = reopen;
          setReopen(null);
          if (target === null) return;
          reportFailure(
            "Could not reopen the issue",
            await write({
              environmentId: target.card.environmentId,
              input: {
                projectId: target.card.projectId,
                action: "issue.move",
                id: target.card.issue.id,
                status: target.status,
                reopenReason: reason,
              },
            }),
          );
        }}
      />
      {panelProject !== null ? (
        <IssuePanel
          environmentId={panelProject.environmentId}
          projectId={panelProject.projectId}
          issueId={search.issue ?? null}
          categories={boardOf(panelProject)?.decisionCategories ?? []}
          issues={boardOf(panelProject)?.issues ?? []}
          canWrite={canWritePanel}
          onClose={closePanel}
        />
      ) : null}
    </SidebarInset>
  );
}

import {
  KANBAN_PROJECTS_MAX,
  type EnvironmentId,
  type KanbanBoardFolder,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import type { Project } from "~/types";

/** A project the board can show, named as the sidebar names its group. */
export interface BoardProject extends ScopedProjectRef {
  /**
   * The group's name, with the environment's label once the scope spans more than one, and, when
   * another project would read the same, the checkout's path, or a short id where that is shared.
   */
  readonly label: string;
}

/** What one environment of the scope says about the board. */
export interface BoardEnvironment {
  readonly environmentId: EnvironmentId;
  /** Whether it runs kanban; null while unknown. */
  readonly active: boolean | null;
  /**
   * Its projects' board folders, with or without a board there; null until known, and on an
   * environment without kanban.
   */
  readonly folders: ReadonlyArray<KanbanBoardFolder> | null;
  readonly error: string | null;
}

export const boardProjectKey = (ref: ScopedProjectRef) =>
  `${ref.environmentId}\u0000${ref.projectId}`;

/**
 * Project ids per environment, once each and sorted, so the same projects make the same reads in
 * any order, split into reads of at most `KANBAN_PROJECTS_MAX`, the most one read takes.
 */
export function projectIdsByEnvironment(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<ReadonlyArray<ProjectId>>]> {
  const grouped = new Map<EnvironmentId, Set<ProjectId>>();
  for (const ref of refs)
    grouped.set(
      ref.environmentId,
      (grouped.get(ref.environmentId) ?? new Set()).add(ref.projectId),
    );
  return [...grouped].map(([environmentId, ids]) => {
    const sorted = [...ids].toSorted();
    return [
      environmentId,
      Array.from({ length: Math.ceil(sorted.length / KANBAN_PROJECTS_MAX) }, (_, index) =>
        sorted.slice(index * KANBAN_PROJECTS_MAX, (index + 1) * KANBAN_PROJECTS_MAX),
      ),
    ];
  });
}

/**
 * `items` with each label that more than one of them shares told apart, by the first of the item's
 * `marks` that none of the others sharing it has, else by its last, a short id.
 */
function tellApart<T extends { readonly label: string }>(
  items: ReadonlyArray<T>,
  marks: (item: T) => ReadonlyArray<string | undefined>,
): ReadonlyArray<T> {
  const alike = new Map<string, Array<T>>();
  for (const item of items) alike.set(item.label, [...(alike.get(item.label) ?? []), item]);
  return items.map((item) => {
    const others = (alike.get(item.label) ?? []).filter((other) => other !== item);
    if (others.length === 0) return item;
    const own = marks(item);
    const mark =
      own.find(
        (candidate, index) =>
          candidate !== undefined && others.every((other) => marks(other)[index] !== candidate),
      ) ?? own.at(-1);
    return { ...item, label: `${item.label} · ${mark}` };
  });
}

/**
 * The scope picker's name for each group, by its `projectKey`: the group's name, told apart from
 * another group of that name by its environment, else its path, else a short id.
 */
export function scopeGroupLabels(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): ReadonlyMap<string, string> {
  const named = tellApart(
    groups.map((group) => ({ group, label: group.displayName })),
    ({ group }) => [
      group.memberProjects.find((member) => member.environmentId === group.environmentId)
        ?.environmentLabel ?? undefined,
      group.workspaceRoot,
      group.id.slice(0, 8),
    ],
  );
  return new Map(named.map(({ group, label }) => [group.projectKey, label]));
}

/**
 * The projects the board covers under the sidebar's project scope, which the board shares so it
 * and the thread list agree: every project with no scope, else the scoped group's. Like the
 * sidebar, it takes each group's every project id, not only the one shown for a path registered
 * twice, since an older id can have a board of its own. A scope that names no group, while one is
 * being restored or after it is gone, covers every project, as the sidebar's list does.
 */
export function scopedBoardProjects(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  scopeKey: string | null,
  projects: ReadonlyArray<Pick<Project, "environmentId" | "id" | "workspaceRoot">>,
): ReadonlyArray<BoardProject> {
  const scoped = groups.find((group) => group.projectKey === scopeKey);
  const refs = (scoped === undefined ? groups : [scoped]).flatMap((group) =>
    group.memberProjectRefs.map((ref) => ({ group, ref })),
  );
  const workspaceRoots = new Map(
    projects.map((project) => [
      boardProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      project.workspaceRoot,
    ]),
  );
  const spansEnvironments = new Set(refs.map(({ ref }) => ref.environmentId)).size > 1;
  const named = refs.map(({ group, ref }) => ({
    environmentId: ref.environmentId,
    projectId: ref.projectId,
    label: [
      group.displayName,
      spansEnvironments
        ? (group.memberProjects.find((member) => member.environmentId === ref.environmentId)
            ?.environmentLabel ?? null)
        : null,
    ]
      .filter((part) => part !== null)
      .join(" · "),
  }));
  // Projects that would read alike (two checkouts of a group on one environment, a path registered
  // twice, two groups of one name) are told apart by their paths, else by a short id.
  const pathOf = (ref: ScopedProjectRef) => workspaceRoots.get(boardProjectKey(ref));
  return tellApart(named, (project) => [pathOf(project), project.projectId.slice(0, 8)]);
}

/**
 * Splits the scope's projects by what the board does with them. `writable` are those on an
 * environment known to run kanban, where a new card can go. `shown` are those of them with a
 * board, one subscription each. A project without a board is never subscribed, since loading a
 * board creates its folder and watchers; its first card or folder starts one.
 */
export function boardFanOut(
  projects: ReadonlyArray<BoardProject>,
  environments: ReadonlyArray<BoardEnvironment>,
): { readonly writable: ReadonlyArray<BoardProject>; readonly shown: ReadonlyArray<BoardProject> } {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writable = projects.filter((project) => byId.get(project.environmentId)?.active === true);
  const shown = writable.filter((project) => boardFolder(environments, project)?.board === true);
  return { writable, shown };
}

/** The project's board folder as its environment last read it; undefined until then. */
export function boardFolder(
  environments: ReadonlyArray<BoardEnvironment>,
  ref: ScopedProjectRef,
): KanbanBoardFolder | undefined {
  return environments
    .find((environment) => environment.environmentId === ref.environmentId)
    ?.folders?.find((folder) => folder.projectId === ref.projectId);
}

const sameRef = (left: ScopedProjectRef) => (right: ScopedProjectRef) =>
  left.environmentId === right.environmentId && left.projectId === right.projectId;

/**
 * The project the URL names when the scope leaves it out, labelled as in the unscoped board; null
 * when the URL names none, one in the scope, or one this client does not know. A link or "Find
 * decision" names it, so the decisions view shows it as the issue panel does, without changing the
 * scope; the columns keep to the scope.
 */
export function linkedOutsideScope(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  projects: ReadonlyArray<Pick<Project, "environmentId" | "id" | "workspaceRoot">>,
  scoped: ReadonlyArray<BoardProject>,
  linked: ScopedProjectRef | null,
): BoardProject | null {
  if (linked === null || scoped.some(sameRef(linked))) return null;
  return scopedBoardProjects(groups, null, projects).find(sameRef(linked)) ?? null;
}

/** Whether the environment's read of its board folders has answered, or it runs no kanban. */
const boardsRead = ({ active, folders, error }: BoardEnvironment) =>
  active === false || (active === true && (folders !== null || error !== null));

/**
 * Whether `ref` has a board: from the scope's read, `environments`, when the scope covers it, else
 * from its own, `outsideEnvironments`; null until that read answers. A failed read counts as none.
 * Nothing reads a project's issue or decisions or subscribes to its board before this says it has
 * one, since loading a board creates its folder and watchers.
 */
export function linkedBoard(
  scoped: ReadonlyArray<BoardProject>,
  environments: ReadonlyArray<BoardEnvironment>,
  outsideEnvironments: ReadonlyArray<BoardEnvironment>,
  ref: ScopedProjectRef,
): boolean | null {
  const read = scoped.some(sameRef(ref)) ? environments : outsideEnvironments;
  const environment = read.find((candidate) => candidate.environmentId === ref.environmentId);
  if (environment === undefined || !boardsRead(environment)) return null;
  return environment.active === true && boardFolder(read, ref)?.board === true;
}

/**
 * What the decisions view picks from: the shown boards, then the URL's project outside the scope
 * when `outsideBoard` says it has a board. Null while it cannot tell yet: until the outside
 * project's read answers, so it does not show another project first, and while nothing has a board
 * but some of the scope's reads are unanswered, so it does not claim there is none.
 */
export function decisionsViewProjects(
  shown: ReadonlyArray<BoardProject>,
  environments: ReadonlyArray<BoardEnvironment>,
  outside: BoardProject | null,
  outsideBoard: boolean | null,
): ReadonlyArray<BoardProject> | null {
  if (outside !== null && outsideBoard === null) return null;
  const projects = outside !== null && outsideBoard === true ? [...shown, outside] : shown;
  return projects.length === 0 && !environments.every(boardsRead) ? null : projects;
}

/**
 * The boards the page subscribes to: every board the view shows, and, while an issue is open, its
 * project's, which the URL can name outside the scope, so its panel has the project's categories
 * and tickets.
 */
export function subscribedBoards(
  shown: ReadonlyArray<BoardProject>,
  openIssueProject: ScopedProjectRef | null,
): ReadonlyArray<ScopedProjectRef> {
  return openIssueProject === null ||
    shown.some(
      (project) =>
        project.environmentId === openIssueProject.environmentId &&
        project.projectId === openIssueProject.projectId,
    )
    ? shown
    : [
        ...shown,
        { environmentId: openIssueProject.environmentId, projectId: openIssueProject.projectId },
      ];
}

/** The first of `preferred` that is one of `options`, else the first option; null without any. */
export function pickBoardProject(
  options: ReadonlyArray<BoardProject>,
  ...preferred: ReadonlyArray<ScopedProjectRef | null>
): BoardProject | null {
  for (const ref of preferred) {
    const match =
      ref === null
        ? undefined
        : options.find(
            (option) =>
              option.environmentId === ref.environmentId && option.projectId === ref.projectId,
          );
    if (match !== undefined) return match;
  }
  return options[0] ?? null;
}

/**
 * The decisions view's category filter and open decision (`category/id`). Both are a project's, so
 * they hold only for the project they were picked in, which the URL carries with them; once the
 * view shows another project, however the scope changed, it shows every category and no decision.
 */
export function decisionsViewSearch(
  search: {
    readonly environmentId?: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly category?: string;
    readonly decision?: string;
  },
  project: ScopedProjectRef,
): { readonly category: string | undefined; readonly decision: string | undefined } {
  return search.environmentId === project.environmentId && search.projectId === project.projectId
    ? { category: search.category, decision: search.decision }
    : { category: undefined, decision: undefined };
}

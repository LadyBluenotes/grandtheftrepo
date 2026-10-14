import type {
  EnvironmentId,
  KanbanBoardFolder,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import type { Project } from "~/types";

/** A project the board can show, named as the sidebar names its group. */
export interface BoardProject extends ScopedProjectRef {
  /**
   * The group's name, with the environment's label once the scope spans more than one, and the
   * checkout's path when its group has another checkout on the same environment.
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

/** Project ids per environment, sorted, so the same projects make the same read in any order. */
export function projectIdsByEnvironment(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<ProjectId>]> {
  const grouped = new Map<EnvironmentId, Array<ProjectId>>();
  for (const ref of refs)
    grouped.set(ref.environmentId, [...(grouped.get(ref.environmentId) ?? []), ref.projectId]);
  return [...grouped].map(([environmentId, projectIds]) => [environmentId, projectIds.toSorted()]);
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
  return refs.map(({ group, ref }) => {
    const onEnvironment = group.memberProjects.filter(
      (member) => member.environmentId === ref.environmentId,
    );
    return {
      environmentId: ref.environmentId,
      projectId: ref.projectId,
      label: [
        group.displayName,
        spansEnvironments ? (onEnvironment[0]?.environmentLabel ?? null) : null,
        // Two checkouts of the group on one environment are told apart by their paths.
        onEnvironment.length > 1 ? (workspaceRoots.get(boardProjectKey(ref)) ?? null) : null,
      ]
        .filter((part) => part !== null)
        .join(" · "),
    };
  });
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

/**
 * What the decisions view picks from: the shown boards, then the URL's project outside the scope
 * once its own read, `outsideEnvironments`, says it has a board, since reading its decisions loads
 * its board. Nothing until that read answers, so the view does not show another project first.
 */
export function decisionsViewProjects(
  shown: ReadonlyArray<BoardProject>,
  outside: BoardProject | null,
  outsideEnvironments: ReadonlyArray<BoardEnvironment>,
): ReadonlyArray<BoardProject> {
  if (outside === null) return shown;
  const unknown = outsideEnvironments.some(
    ({ active, folders, error }) =>
      active === null || (active && folders === null && error === null),
  );
  if (unknown) return [];
  return boardFanOut([outside], outsideEnvironments).shown.length === 0
    ? shown
    : [...shown, outside];
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

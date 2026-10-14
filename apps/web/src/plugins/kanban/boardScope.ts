import type {
  EnvironmentId,
  KanbanBoardFolder,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";

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

/**
 * The projects the board covers under the sidebar's project scope, which the board shares so it
 * and the thread list agree: every project with no scope, else the scoped group's members. A scope
 * that names no group, while one is being restored or after it is gone, covers every project, as
 * the sidebar's list does.
 */
export function scopedBoardProjects(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  scopeKey: string | null,
): ReadonlyArray<BoardProject> {
  const scoped = groups.find((group) => group.projectKey === scopeKey);
  const members = (scoped === undefined ? groups : [scoped]).flatMap((group) =>
    group.memberProjects.map((member) => ({ group, member })),
  );
  const spansEnvironments = new Set(members.map(({ member }) => member.environmentId)).size > 1;
  return members.map(({ group, member }) => {
    const sharesEnvironment = group.memberProjects.some(
      (other) => other !== member && other.environmentId === member.environmentId,
    );
    return {
      environmentId: member.environmentId,
      projectId: member.id,
      label: [
        group.displayName,
        spansEnvironments ? member.environmentLabel : null,
        sharesEnvironment ? member.workspaceRoot : null,
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
 * The decisions view's category filter. A category is a project's, so it holds only for the
 * project it was picked in, which the URL carries with it; once the view shows another project,
 * however the scope changed, it shows every category.
 */
export function decisionsCategory(
  search: {
    readonly environmentId?: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly category?: string;
  },
  project: ScopedProjectRef,
): string | undefined {
  return search.environmentId === project.environmentId && search.projectId === project.projectId
    ? search.category
    : undefined;
}

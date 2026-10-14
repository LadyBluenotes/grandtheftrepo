import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import type { Project } from "~/types";
import {
  boardFanOut,
  decisionsViewSearch,
  pickBoardProject,
  projectIdsByEnvironment,
  scopedBoardProjects,
  subscribedBoards,
} from "./boardScope";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/app.git",
  },
};

const project = (environmentId: EnvironmentId, id: string, title: string, shared = false) =>
  ({
    id: ProjectId.make(id),
    environmentId,
    title,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: shared ? repositoryIdentity : null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }) satisfies Project;

// One repository checked out on both environments, which the sidebar groups, and a notes folder.
const appHere = project(local, "app-here", "app", true);
const appThere = project(remote, "app-there", "app", true);
const notes = project(local, "notes", "notes");
const projects = [appHere, appThere, notes];
const groups = buildSidebarProjectSnapshots({
  projects,
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  groupScratchProjects: true,
  primaryEnvironmentId: local,
  resolveEnvironmentLabel: (id) => (id === local ? "Laptop" : "Server"),
});
const keyOf = (title: string) => groups.find((group) => group.displayName === title)!.projectKey;
const refs = (projects: ReadonlyArray<{ environmentId: string; projectId: string }>) =>
  projects.map((p) => `${p.environmentId}/${p.projectId}`);

describe("scopedBoardProjects", () => {
  it("covers every project when the sidebar has no scope, naming environments when they differ", () => {
    const all = scopedBoardProjects(groups, null, projects);
    expect(refs(all).toSorted()).toEqual([
      "env-local/app-here",
      "env-local/notes",
      "env-remote/app-there",
    ]);
    expect(all.find((p) => p.projectId === appThere.id)?.label).toBe("app · Server");
  });

  it("covers the scoped group's members, on every environment", () => {
    expect(refs(scopedBoardProjects(groups, keyOf("app"), projects)).toSorted()).toEqual([
      "env-local/app-here",
      "env-remote/app-there",
    ]);
    const [only, ...rest] = scopedBoardProjects(groups, keyOf("notes"), projects);
    expect(rest).toEqual([]);
    expect(only).toEqual({ environmentId: local, projectId: notes.id, label: "notes" });
  });

  it("covers every project while the scope names no group", () => {
    expect(scopedBoardProjects(groups, "gone", projects)).toHaveLength(3);
  });

  it("tells two checkouts of one group on one environment apart by their paths", () => {
    const appClone = { ...project(local, "app-clone", "app", true), workspaceRoot: "/work/clone" };
    const withClone = buildSidebarProjectSnapshots({
      projects: [appHere, appClone],
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      groupScratchProjects: true,
      primaryEnvironmentId: local,
      resolveEnvironmentLabel: () => "Laptop",
    });
    expect(scopedBoardProjects(withClone, null, [appHere, appClone]).map((p) => p.label)).toEqual([
      "app · /work/app-here",
      "app · /work/clone",
    ]);
  });

  it("covers an older id registered at the same path, which can have a board of its own", () => {
    const older = { ...project(local, "notes-old", "notes"), workspaceRoot: notes.workspaceRoot };
    const both = [{ ...notes, updatedAt: "2026-02-01T00:00:00.000Z" }, older];
    const withOlder = buildSidebarProjectSnapshots({
      projects: both,
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      groupScratchProjects: true,
      primaryEnvironmentId: local,
      resolveEnvironmentLabel: () => "Laptop",
    });
    // The sidebar shows the fresher registration only, but scopes by both.
    expect(withOlder[0]?.memberProjects.map((p) => p.id)).toEqual([notes.id]);
    expect(scopedBoardProjects(withOlder, null, both)).toEqual([
      { environmentId: local, projectId: notes.id, label: "notes" },
      { environmentId: local, projectId: older.id, label: "notes" },
    ]);
  });
});

describe("projectIdsByEnvironment", () => {
  it("reads attention for every writable project, a project without a board included", () => {
    const { writable } = boardFanOut(scopedBoardProjects(groups, null, projects), [
      {
        environmentId: local,
        active: true,
        folders: [{ projectId: notes.id, directory: "/wiki/notes", board: true }],
        error: null,
      },
      { environmentId: remote, active: true, folders: [], error: null },
    ]);
    expect(projectIdsByEnvironment(writable).toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      [local, [appHere.id, notes.id]],
      [remote, [appThere.id]],
    ]);
  });
});

describe("boardFanOut", () => {
  const all = scopedBoardProjects(groups, null, projects);
  const folder = (p: Project, board: boolean) => ({
    projectId: p.id,
    directory: `/home/me/.t3/wiki/${p.id}`,
    board,
  });

  it("subscribes only to projects with a board on an environment that runs kanban", () => {
    const { writable, shown } = boardFanOut(all, [
      {
        environmentId: local,
        active: true,
        folders: [folder(appHere, true), folder(notes, false)],
        error: null,
      },
      { environmentId: remote, active: false, folders: null, error: null },
    ]);
    expect(refs(writable).toSorted()).toEqual(["env-local/app-here", "env-local/notes"]);
    expect(refs(shown)).toEqual(["env-local/app-here"]);
  });

  it("subscribes to nothing on an environment until it is known to run kanban and its boards are read", () => {
    expect(
      boardFanOut(all, [
        { environmentId: local, active: true, folders: null, error: null },
        { environmentId: remote, active: null, folders: null, error: null },
      ]),
    ).toEqual({
      writable: all.filter((p) => p.environmentId === local),
      shown: [],
    });
  });
});

describe("pickBoardProject", () => {
  const options = scopedBoardProjects(groups, null, projects);
  const ref = (p: Project) => ({ environmentId: p.environmentId, projectId: p.id });

  it("takes the first preference that is an option, else the first option", () => {
    expect(pickBoardProject(options, ref(notes), ref(appThere))?.projectId).toBe(notes.id);
    expect(pickBoardProject(options, null, ref(appThere))?.projectId).toBe(appThere.id);
    expect(
      pickBoardProject(options, { environmentId: remote, projectId: notes.id })?.projectId,
    ).toBe(options[0]?.projectId);
    expect(pickBoardProject([], ref(notes))).toBeNull();
  });

  it("drops a pick the scope no longer covers for the default", () => {
    // Project B picked, then the scope narrowed to the group of A.
    const narrowed = scopedBoardProjects(groups, keyOf("app"), projects);
    expect(pickBoardProject(narrowed, ref(notes), ref(appThere))?.projectId).toBe(appThere.id);
  });
});

describe("decisionsViewSearch", () => {
  const here = { environmentId: local, projectId: notes.id };
  const search = { ...here, category: "auth", decision: "auth/use-oauth" };
  const none = { category: undefined, decision: undefined };

  it("keeps the category and open decision only in the project they were picked in", () => {
    expect(decisionsViewSearch(search, here)).toStrictEqual({
      category: "auth",
      decision: "auth/use-oauth",
    });
    // The sidebar's scope moved the view to another project; the URL still names the old one.
    expect(
      decisionsViewSearch(search, { environmentId: local, projectId: appHere.id }),
    ).toStrictEqual(none);
    expect(
      decisionsViewSearch(search, { environmentId: remote, projectId: notes.id }),
    ).toStrictEqual(none);
    expect(
      decisionsViewSearch({ category: "auth", decision: "auth/use-oauth" }, here),
    ).toStrictEqual(none);
  });
});

describe("subscribedBoards", () => {
  const all = scopedBoardProjects(groups, null, projects);
  const shown = all.filter((p) => p.projectId === appHere.id);
  const ref = (p: Project) => ({ environmentId: p.environmentId, projectId: p.id });

  it("adds the open issue's project once, even outside the scope", () => {
    expect(refs(subscribedBoards(shown, ref(notes)))).toEqual([
      "env-local/app-here",
      "env-local/notes",
    ]);
    expect(subscribedBoards(shown, ref(appHere))).toBe(shown);
  });

  it("subscribes to the shown boards only while no issue is open", () => {
    expect(subscribedBoards(shown, null)).toBe(shown);
  });
});

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "~/sidebarProjectGrouping";
import type { Project } from "~/types";
import { boardFanOut, pickBoardProject, scopedBoardProjects } from "./boardScope";

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
const groups = buildSidebarProjectSnapshots({
  projects: [appHere, appThere, notes],
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
    const all = scopedBoardProjects(groups, null);
    expect(refs(all).toSorted()).toEqual([
      "env-local/app-here",
      "env-local/notes",
      "env-remote/app-there",
    ]);
    expect(all.find((p) => p.projectId === appThere.id)?.label).toBe("app · Server");
  });

  it("covers the scoped group's members, on every environment", () => {
    expect(refs(scopedBoardProjects(groups, keyOf("app"))).toSorted()).toEqual([
      "env-local/app-here",
      "env-remote/app-there",
    ]);
    const [only, ...rest] = scopedBoardProjects(groups, keyOf("notes"));
    expect(rest).toEqual([]);
    expect(only).toEqual({ environmentId: local, projectId: notes.id, label: "notes" });
  });

  it("covers every project while the scope names no group", () => {
    expect(scopedBoardProjects(groups, "gone")).toHaveLength(3);
  });
});

describe("boardFanOut", () => {
  const all = scopedBoardProjects(groups, null);

  it("subscribes only to projects with a board on an environment that runs kanban", () => {
    const { writable, shown } = boardFanOut(all, [
      { environmentId: local, active: true, boards: [appHere.id], error: null },
      { environmentId: remote, active: false, boards: null, error: null },
    ]);
    expect(refs(writable).toSorted()).toEqual(["env-local/app-here", "env-local/notes"]);
    expect(refs(shown)).toEqual(["env-local/app-here"]);
  });

  it("subscribes to nothing on an environment until it is known to run kanban and its boards are read", () => {
    expect(
      boardFanOut(all, [
        { environmentId: local, active: true, boards: null, error: null },
        { environmentId: remote, active: null, boards: null, error: null },
      ]),
    ).toEqual({
      writable: all.filter((p) => p.environmentId === local),
      shown: [],
    });
  });
});

describe("pickBoardProject", () => {
  const options = scopedBoardProjects(groups, null);
  const ref = (p: Project) => ({ environmentId: p.environmentId, projectId: p.id });

  it("takes the first preference that is an option, else the first option", () => {
    expect(pickBoardProject(options, ref(notes), ref(appThere))?.projectId).toBe(notes.id);
    expect(pickBoardProject(options, null, ref(appThere))?.projectId).toBe(appThere.id);
    expect(
      pickBoardProject(options, { environmentId: remote, projectId: notes.id })?.projectId,
    ).toBe(options[0]?.projectId);
    expect(pickBoardProject([], ref(notes))).toBeNull();
  });
});

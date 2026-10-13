import {
  EnvironmentId,
  ProjectId,
  type PluginReadiness,
  type ReadinessCheck,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readinessGroups, readinessLink } from "./state";

const check = (id: string, status: ReadinessCheck["status"]): ReadinessCheck => ({
  id,
  label: id,
  status,
  sentence: `${id} is ${status}.`,
  target: null,
});

const TITLES: Record<string, string> = { routing: "Routing", policy: "Policies" };
const titleOf = (plugin: string) => TITLES[plugin] ?? plugin;

describe("readinessGroups", () => {
  const report: ReadonlyArray<PluginReadiness> = [
    { plugin: "routing", checks: [check("tiers", "attention")] },
    { plugin: "policy", checks: [check("directories", "ready"), check("delivered", "attention")] },
    { plugin: "kanban", checks: [check("directory", "ready"), check("stop", "ready")] },
    { plugin: "review", checks: [check("running", "off")] },
    { plugin: "quiet", checks: [] },
  ];

  it("keeps the server's order, names each plugin and leaves out one with no checks", () => {
    expect(readinessGroups(report, titleOf).map((group) => [group.plugin, group.title])).toEqual([
      ["routing", "Routing"],
      ["policy", "Policies"],
      ["kanban", "kanban"],
      ["review", "review"],
    ]);
  });

  it("shows what is not ready and folds the ready checks away", () => {
    const [, policy, kanban, review] = readinessGroups(report, titleOf);
    expect(policy?.status).toBe("attention");
    expect(policy?.open.map((open) => open.id)).toEqual(["delivered"]);
    expect(policy?.ready.map((ready) => ready.id)).toEqual(["directories"]);
    expect(kanban?.status).toBe("ready");
    expect(kanban?.open).toEqual([]);
    expect(review?.status).toBe("off");
    expect(review?.open.map((open) => open.sentence)).toEqual(["running is off."]);
  });
});

describe("readinessLink", () => {
  const context = {
    plugin: "policy",
    title: "Policies",
    hasScreen: true,
    primary: true,
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
  };

  it("opens the plugin's screen, or its row on this page when it has none", () => {
    expect(readinessLink("plugin", context)).toMatchObject({
      to: "/plugins/$pluginId",
      params: { pluginId: "policy" },
    });
    expect(readinessLink("plugin", { ...context, hasScreen: false })).toEqual({
      kind: "row",
      plugin: "policy",
      label: "Policies settings",
    });
    expect(readinessLink("plugins", context)?.kind).toBe("row");
  });

  it("keeps a non-primary environment's link on its row, since plugin screens show the primary", () => {
    expect(readinessLink("plugin", { ...context, primary: false })).toEqual({
      kind: "row",
      plugin: "policy",
      label: "Policies settings",
    });
  });

  it("opens the project's board in the page's environment, and has no link without a target", () => {
    expect(readinessLink("board", context)).toMatchObject({
      to: "/board",
      search: { environmentId: "env-1", projectId: "project-1" },
    });
    expect(readinessLink("board", { ...context, projectId: null })).toMatchObject({
      search: { environmentId: "env-1" },
    });
    expect(readinessLink(null, context)).toBeNull();
  });
});

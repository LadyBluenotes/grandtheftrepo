import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  LearningFailureKind,
  ProjectId,
  ThreadId,
  type LearningCorrection,
  type LearningItem,
  type PluginStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  correctionsWindow,
  FAILURE_KINDS,
  failureModeLabel,
  filterCorrections,
  itemRows,
  pluginActive,
  threadLabel,
  threadsByActivity,
} from "./state";

const projectId = ProjectId.make("project-1");

const item = (patch: Partial<LearningItem>): LearningItem => ({
  id: 1,
  projectId,
  failureMode: "defect",
  occurrences: 1,
  state: "open",
  ownerKind: null,
  dispositionBy: "rule",
  dispositionAt: null,
  reason: "Opened by a rule.",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

const correction = (patch: Partial<LearningCorrection>): LearningCorrection => ({
  id: 1,
  projectId,
  threadId: ThreadId.make("thread-1"),
  failureKind: "review_verdict",
  causeClass: "defect",
  declaredMode: "defect",
  description: "The redirect loops.",
  sourceEventIds: [],
  sourceKey: null,
  classifiedAt: null,
  classificationReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("itemRows", () => {
  const items = [
    item({ id: 1, updatedAt: "2026-10-01T00:00:00.000Z" }),
    item({
      id: 2,
      state: "closed",
      ownerKind: "policy",
      dispositionBy: "person",
      dispositionAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    }),
    item({ id: 3, updatedAt: "2026-10-02T00:00:00.000Z" }),
  ];

  it("puts the most recently updated first and carries who set the disposition", () => {
    const rows = itemRows(items, null);
    expect(rows.map((row) => row.id)).toEqual([2, 3, 1]);
    expect(rows[0]).toMatchObject({
      state: "closed",
      ownerKind: "policy",
      setBy: "person",
      setAt: "2026-10-03T00:00:00.000Z",
    });
    expect(rows[1]).toMatchObject({ setBy: "rule", setAt: null });
  });

  it("keeps only the state asked for", () => {
    expect(itemRows(items, "open").map((row) => row.id)).toEqual([3, 1]);
    expect(itemRows(items, "closed").map((row) => row.id)).toEqual([2]);
    expect(itemRows(items, "promoted")).toEqual([]);
  });
});

describe("failureModeLabel", () => {
  it("names a declared mode and spaces any other", () => {
    expect(failureModeLabel("missing_verification")).toBe("Missing verification");
    expect(failureModeLabel("efficiency_regression")).toBe("Efficiency regression");
  });
});

describe("filterCorrections", () => {
  const rows = [
    correction({
      id: 1,
      failureKind: "provider_turn_failed",
      declaredMode: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
    correction({ id: 2, declaredMode: "defect", createdAt: "2026-10-02T00:00:00.000Z" }),
    correction({ id: 3, declaredMode: "convention", createdAt: "2026-10-03T00:00:00.000Z" }),
  ];
  const ids = (filter: Parameters<typeof filterCorrections>[1]) =>
    filterCorrections(rows, filter).map((row) => row.id);

  it("lists everything newest first without a filter", () => {
    expect(ids({ kind: null, mode: null })).toEqual([3, 2, 1]);
  });

  it("narrows by kind, by declared mode, and by having none", () => {
    expect(ids({ kind: "review_verdict", mode: null })).toEqual([3, 2]);
    expect(ids({ kind: null, mode: "defect" })).toEqual([2]);
    expect(ids({ kind: null, mode: "none" })).toEqual([1]);
    expect(ids({ kind: "review_verdict", mode: "none" })).toEqual([]);
  });
});

describe("FAILURE_KINDS", () => {
  it("offers every kind of correction the server records as a filter", () => {
    expect([...FAILURE_KINDS].toSorted()).toEqual([...LearningFailureKind.literals].toSorted());
  });
});

describe("correctionsWindow", () => {
  const now = Date.parse("2026-10-13T03:17:45.000Z");

  it("ends at the end of the current hour and holds still until then", () => {
    expect(correctionsWindow(7, now)).toEqual({
      from: "2026-10-06T04:00:00.000Z",
      to: "2026-10-13T04:00:00.000Z",
    });
    expect(correctionsWindow(7, now + 40 * 60_000)).toEqual(correctionsWindow(7, now));
    expect(correctionsWindow(7, now + 60 * 60_000).to).toBe("2026-10-13T05:00:00.000Z");
  });

  it("reaches back the number of days asked for", () => {
    expect(correctionsWindow(30, now).from).toBe("2026-09-13T04:00:00.000Z");
    expect(correctionsWindow(90, now).from).toBe("2026-07-15T04:00:00.000Z");
  });
});

describe("pluginActive", () => {
  const status = (patch: Partial<PluginStatus>): PluginStatus => ({
    id: "review",
    dependsOn: ["learning"],
    enabled: true,
    active: true,
    missing: [],
    startError: null,
    ...patch,
  });

  it("is true only for a plugin that runs now", () => {
    expect(pluginActive(null, "review")).toBe(false);
    expect(pluginActive([status({ active: false })], "review")).toBe(false);
    expect(pluginActive([status({})], "review")).toBe(true);
    expect(pluginActive([status({})], "learning")).toBe(false);
  });
});

describe("threadsByActivity", () => {
  const thread = (id: string, title: string, latestUserMessageAt: string | null) =>
    ({ id: ThreadId.make(id), title, latestUserMessageAt }) as EnvironmentThreadShell;

  it("puts the threads written to most recently first, then the untouched ones by title", () => {
    const sorted = threadsByActivity([
      thread("a", "Zeta", null),
      thread("b", "Alpha", "2026-10-01T00:00:00.000Z"),
      thread("c", "Beta", null),
      thread("d", "Gamma", "2026-10-02T00:00:00.000Z"),
    ]);
    expect(sorted.map((candidate) => candidate.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("labels a thread without a title", () => {
    expect(threadLabel({ title: "  " })).toBe("Untitled thread");
    expect(threadLabel({ title: "Fix login" })).toBe("Fix login");
  });
});

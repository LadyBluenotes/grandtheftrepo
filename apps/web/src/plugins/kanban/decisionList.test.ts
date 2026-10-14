import type { KanbanDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterDecisions, sortDecisions, type DecisionFilter } from "./decisionList";

const decision = (id: string, patch: Partial<KanbanDecision> = {}): KanbanDecision => ({
  category: "general",
  id,
  state: "accepted",
  title: id,
  why: "",
  alternatives: [],
  reconsiderWhen: null,
  supersedes: [],
  supersededBy: null,
  issues: [],
  threads: [],
  by: "user",
  at: "2026-10-01T00:00:00.000Z",
  revisions: [],
  ...patch,
});

const all: DecisionFilter = { query: "", state: null, category: null, showSuperseded: false };
const ids = (decisions: ReadonlyArray<KanbanDecision>) => decisions.map((d) => d.id);

describe("filterDecisions", () => {
  const sqlite = decision("queue-in-sqlite", {
    title: "Queue jobs in SQLite",
    why: "No extra service to run.",
    alternatives: [
      {
        title: "Kafka",
        disposition: "rejected",
        reason: "Too heavy for one machine.",
        reasonKind: "contextual",
      },
    ],
  });
  const retries = decision("retry-with-backoff", {
    title: "Retry failed jobs",
    why: "Backoff with jitter keeps the API calm.",
  });

  it("finds a decision by a word in its title, why or an alternative, in any case", () => {
    const list = [sqlite, retries];
    expect(ids(filterDecisions(list, { ...all, query: "sqlite" }))).toEqual([sqlite.id]);
    expect(ids(filterDecisions(list, { ...all, query: "JITTER" }))).toEqual([retries.id]);
    expect(ids(filterDecisions(list, { ...all, query: "kafka" }))).toEqual([sqlite.id]);
    expect(ids(filterDecisions(list, { ...all, query: "machine" }))).toEqual([sqlite.id]);
    expect(ids(filterDecisions(list, { ...all, query: "postgres" }))).toEqual([]);
  });

  it("keeps only decisions matching every word, so typing more narrows", () => {
    const list = [sqlite, retries];
    expect(ids(filterDecisions(list, { ...all, query: "jobs" }))).toHaveLength(2);
    expect(ids(filterDecisions(list, { ...all, query: "jobs, kafka" }))).toEqual([sqlite.id]);
  });

  it("hides superseded decisions until the toggle is on or the state asks for them", () => {
    const old = decision("old", { state: "superseded", supersededBy: "general/new" });
    const current = decision("new", { supersedes: ["general/old"] });
    const list = [old, current];
    expect(ids(filterDecisions(list, all))).toEqual([current.id]);
    expect(ids(filterDecisions(list, { ...all, showSuperseded: true })).sort()).toEqual([
      current.id,
      old.id,
    ]);
    expect(ids(filterDecisions(list, { ...all, state: "superseded" }))).toEqual([old.id]);
  });

  it("narrows by state and category", () => {
    const list = [
      decision("a", { category: "auth" }),
      decision("b", { category: "auth", state: "conflicted" }),
      decision("c", { category: "storage", state: "conflicted" }),
    ];
    expect(ids(filterDecisions(list, { ...all, category: "auth" })).sort()).toEqual(["a", "b"]);
    expect(ids(filterDecisions(list, { ...all, state: "conflicted" })).sort()).toEqual(["b", "c"]);
    expect(ids(filterDecisions(list, { ...all, category: "auth", state: "conflicted" }))).toEqual([
      "b",
    ]);
  });
});

describe("sortDecisions", () => {
  it("puts the most recently changed first, by its newest revision, and ties by reference", () => {
    const recordedLate = decision("recorded-late", { at: "2026-10-05T00:00:00.000Z" });
    const revisedLater = decision("revised-later", {
      at: "2026-10-01T00:00:00.000Z",
      revisions: [
        { at: "2026-10-01T00:00:00.000Z", by: "user", change: "created: accepted" },
        { at: "2026-10-07T00:00:00.000Z", by: "user", change: "state: accepted → conflicted" },
      ],
    });
    const tieB = decision("b", { category: "x", at: "2026-09-01T00:00:00.000Z" });
    const tieA = decision("a", { category: "x", at: "2026-09-01T00:00:00.000Z" });
    expect(ids(sortDecisions([tieB, recordedLate, tieA, revisedLater]))).toEqual([
      "revised-later",
      "recorded-late",
      "a",
      "b",
    ]);
  });
});

import {
  KANBAN_STATUSES,
  ThreadId,
  type KanbanBoard,
  type KanbanIssueSummary,
  type KanbanStatus,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  boardEntryVisible,
  boardGroups,
  boardState,
  boardThread,
  type BoardThread,
} from "./boardGroups";

const NOW = "2026-10-13T12:00:00.000Z";

function issue(
  id: string,
  status: KanbanStatus,
  overrides: Partial<KanbanIssueSummary> = {},
): KanbanIssueSummary {
  return {
    id,
    title: `Ticket ${id}`,
    status,
    priority: "p2",
    labels: [],
    verification: "unverified",
    tier: null,
    blocked: null,
    reopened: null,
    threads: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: "user",
    updatedAt: "2026-10-01T00:00:00.000Z",
    doneAt: null,
    archivedAt: null,
    criteriaOpen: 0,
    criteriaTotal: 0,
    ...overrides,
  };
}

const board = (issues: ReadonlyArray<KanbanIssueSummary>): KanbanBoard => ({
  directory: "/wiki/project",
  issues,
  decisionCategories: [],
});

const noThreads = () => undefined;

function pullRequest(number: number): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "LadyBluenotes/t3code",
    number,
    url: `https://github.com/LadyBluenotes/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-10-10T00:00:00.000Z",
    snapshot: null,
    stack: null,
  };
}

const link = (id: string, linkedAt: string) => ({ id: ThreadId.make(id), linkedAt });

describe("boardGroups", () => {
  it("makes one group per column in the board's order, however the tickets arrive", () => {
    const groups = boardGroups(
      board([
        issue("done-1", "done"),
        issue("review-1", "in_review"),
        issue("triage-1", "triage"),
        issue("todo-1", "todo"),
        issue("review-2", "in_review"),
        issue("working-1", "in_progress"),
        issue("inbox-1", "inbox"),
      ]),
      noThreads,
    );
    expect(groups.map((group) => group.status)).toEqual(KANBAN_STATUSES);
    expect(groups.map((group) => group.label)).toEqual([
      "Triage",
      "Inbox",
      "Todo",
      "In progress",
      "In review",
      "Done",
    ]);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1, 1, 1, 2, 1]);
  });

  it("drops a column with no tickets", () => {
    const groups = boardGroups(board([issue("a", "done"), issue("b", "todo")]), noThreads);
    expect(groups.map((group) => group.status)).toEqual(["todo", "done"]);
  });

  it("keeps archived tickets out, so a column of only archived tickets disappears", () => {
    const groups = boardGroups(
      board([
        issue("old", "done", { archivedAt: "2026-10-09T00:00:00.000Z" }),
        issue("live", "todo"),
      ]),
      noThreads,
    );
    expect(groups.map((group) => group.status)).toEqual(["todo"]);
  });

  it("orders a column by priority, then age, as the web board does", () => {
    const [group] = boardGroups(
      board([
        issue("late-p1", "todo", { priority: "p1", createdAt: "2026-10-05T00:00:00.000Z" }),
        issue("p3", "todo", { priority: "p3" }),
        issue("early-p1", "todo", { priority: "p1", createdAt: "2026-10-02T00:00:00.000Z" }),
      ]),
      noThreads,
    );
    expect(group?.rows.map((row) => row.id)).toEqual(["early-p1", "late-p1", "p3"]);
  });

  it("counts open acceptance criteria, and says nothing for a ticket without any", () => {
    const [group] = boardGroups(
      board([
        issue("with", "todo", { priority: "p1", criteriaOpen: 2, criteriaTotal: 5 }),
        issue("without", "todo", { priority: "p2" }),
      ]),
      noThreads,
    );
    expect(group?.rows.map((row) => row.labels)).toEqual([["2 of 5 open"], []]);
  });

  it("marks a ticket an agent blocked", () => {
    const [group] = boardGroups(
      board([
        issue("stuck", "in_progress", {
          blocked: { reason: "Needs a key", at: "2026-10-12T00:00:00.000Z", by: "system" },
          criteriaOpen: 1,
          criteriaTotal: 3,
        }),
      ]),
      noThreads,
    );
    expect(group?.rows[0]?.labels).toEqual(["Needs you", "1 of 3 open"]);
  });

  it("shows both the pull request and Snoozed for a snoozed ticket with a pull request", () => {
    const shell = makeThreadShellFixture({
      id: ThreadId.make("thread-a"),
      snoozedUntil: "2026-10-14T09:00:00.000Z",
      snoozedAt: "2026-10-13T09:00:00.000Z",
      pullRequests: [pullRequest(42)],
    });
    const [group] = boardGroups(
      board([
        issue("t", "in_review", {
          criteriaOpen: 2,
          criteriaTotal: 5,
          threads: [link("thread-a", "2026-10-10T00:00:00.000Z")],
        }),
      ]),
      (id) => (id === shell.id ? boardThread(shell, NOW) : undefined),
    );
    expect(group?.rows[0]).toEqual({
      id: "t",
      title: "Ticket t",
      labels: ["2 of 5 open", "#42", "Snoozed"],
      threadId: "thread-a",
    });
  });

  it("opens and describes the most recently linked thread this client has", () => {
    const threads = new Map<string, BoardThread>([
      ["old", { snoozed: true, pullRequestNumber: 7 }],
      ["new", { snoozed: false, pullRequestNumber: 9 }],
    ]);
    const [group] = boardGroups(
      board([
        issue("t", "in_progress", {
          threads: [
            link("old", "2026-10-02T00:00:00.000Z"),
            link("gone", "2026-10-09T00:00:00.000Z"),
            link("new", "2026-10-05T00:00:00.000Z"),
          ],
        }),
        issue("alone", "in_progress", { threads: [link("gone", "2026-10-09T00:00:00.000Z")] }),
      ]),
      (id) => threads.get(id),
    );
    expect(group?.rows.map((row) => [row.id, row.threadId, row.labels])).toEqual([
      ["t", "new", ["#9"]],
      ["alone", null, []],
    ]);
  });
});

describe("boardThread", () => {
  it("is snoozed only while the wake time is ahead", () => {
    const snoozed = (snoozedUntil: string) =>
      boardThread(
        makeThreadShellFixture({ snoozedUntil, snoozedAt: "2026-10-13T09:00:00.000Z" }),
        NOW,
      ).snoozed;
    expect(snoozed("2026-10-14T09:00:00.000Z")).toBe(true);
    expect(snoozed("2026-10-13T10:00:00.000Z")).toBe(false);
  });

  it("names the open pull request over a merged one, and has none without a link", () => {
    const snapshot = (state: "open" | "merged") => ({
      state,
      title: "Change",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-10-12T00:00:00.000Z",
      syncedAt: "2026-10-12T00:00:00.000Z",
    });
    const number = (links: ReadonlyArray<ThreadPullRequestLink>) =>
      boardThread(makeThreadShellFixture({ pullRequests: links }), NOW).pullRequestNumber;
    expect(
      number([
        { ...pullRequest(5), snapshot: snapshot("merged") },
        { ...pullRequest(6), snapshot: snapshot("open") },
      ]),
    ).toBe(6);
    expect(number([{ ...pullRequest(5), snapshot: snapshot("merged") }])).toBe(5);
    expect(number([])).toBeNull();
  });
});

describe("boardState", () => {
  const idle = { error: null, threadOf: noThreads } as const;

  it("signals the empty state for a board with no tickets, or only archived ones", () => {
    const empty = { kind: "empty", message: "No tickets in this project." } as const;
    expect(boardState({ ...idle, active: true, board: board([]) })).toEqual(empty);
    expect(
      boardState({
        ...idle,
        active: true,
        board: board([issue("a", "done", { archivedAt: "2026-10-09T00:00:00.000Z" })]),
      }),
    ).toEqual(empty);
  });

  it("lists the groups once the board has tickets", () => {
    const state = boardState({ ...idle, active: true, board: board([issue("a", "todo")]) });
    expect(state.kind === "groups" && state.groups.map((group) => group.status)).toEqual(["todo"]);
  });

  it("hides the entry and says so when the server does not run the plugin", () => {
    // A server without the plugin RPCs fails `plugins.list`, which the shared atom reports as off.
    expect(boardEntryVisible(false)).toBe(false);
    expect(boardEntryVisible(null)).toBe(false);
    expect(boardEntryVisible(true)).toBe(true);
    expect(boardState({ ...idle, active: false, board: null })).toEqual({
      kind: "unavailable",
      message: "This server does not have the board.",
    });
  });

  it("waits while the server has not answered, and reports a failure only without a board", () => {
    expect(boardState({ ...idle, active: null, board: null })).toEqual({ kind: "loading" });
    expect(boardState({ ...idle, active: true, board: null })).toEqual({ kind: "loading" });
    expect(boardState({ ...idle, active: true, board: null, error: "offline" })).toEqual({
      kind: "failed",
      message: "offline",
    });
    expect(
      boardState({
        ...idle,
        active: true,
        board: board([issue("a", "todo")]),
        error: "offline",
      }).kind,
    ).toBe("groups");
  });
});

import { kanbanAttentionStripRows } from "@t3tools/client-runtime/plugins/kanban";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionResumeTarget,
  boardAttentionTitle,
  boardChanges,
  buildIssuePrompt,
  findDecisionSearch,
  validateBoardSearch,
} from "./state";

const issue = {
  id: "fix-login-redirect",
  title: "Fix login redirect",
  description: "Loops on an expired cookie.",
  status: "todo" as const,
  priority: "p2" as const,
  labels: [],
  verification: "verified" as const,
  tier: null,
  criteria: [],
  findings: [],
  closureCheck: true,
  noDecision: null,
  blocked: null,
  reopened: null,
  threads: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  createdBy: "user",
  updatedAt: "2026-10-12T00:00:00.000Z",
  doneAt: null,
  archivedAt: null,
  log: [],
};
const decision = (category: string, state: "accepted" | "superseded") => ({
  category,
  id: `${category}-${state}`,
  state,
  title: "Some call",
  why: "A long justification that must not reach the prompt.",
  alternatives: [],
  reconsiderWhen: null,
  supersedes: [],
  supersededBy: null,
  issues: [issue.id],
  threads: [],
  by: "user",
  at: "2026-10-12T00:00:00.000Z",
  revisions: [],
});

describe("buildIssuePrompt", () => {
  it("indexes decisions by category without pasting their bodies", () => {
    const prompt = buildIssuePrompt(
      issue,
      [
        decision("auth", "accepted"),
        decision("auth", "superseded"),
        decision("general", "accepted"),
      ],
      [
        { category: "auth", count: 12 },
        { category: "general", count: 7 },
      ],
    );
    expect(prompt.startsWith("Fix login redirect\n\nLoops on an expired cookie.")).toBe(true);
    expect(prompt).toContain(
      "Decisions on this ticket (3): auth: accepted 1, superseded 1; general: accepted 1",
    );
    expect(prompt).toContain("Decision categories: auth (12), general (7)");
    expect(prompt).toContain("kanban_list kind=decision issue=fix-login-redirect");
    expect(prompt).not.toContain("justification");
  });

  it("lists acceptance criteria as a checklist", () => {
    const prompt = buildIssuePrompt(
      {
        ...issue,
        criteria: [
          { id: "c1", text: "Tests pass", checked: true },
          { id: "c2", text: "Docs updated", checked: false },
        ],
      },
      [],
      [],
    );
    expect(prompt).toContain(
      "Acceptance criteria (done means every box is checked):\n- [x] Tests pass\n- [ ] Docs updated",
    );
  });

  it("says when there is nothing to inherit and skips an empty description", () => {
    const prompt = buildIssuePrompt({ ...issue, description: "" }, [], []);
    expect(prompt).toContain("Decisions on this ticket: none.");
    expect(prompt).toContain("Decision categories: none yet.");
    expect(prompt).not.toContain("\n\n\n");
  });
});

describe("attentionResumeTarget", () => {
  // A board on an environment that is not the primary one.
  const board = {
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project-1"),
  };
  const row = (target: "thread" | "board" | "settings", threadId: string | null = null) => ({
    kind: "two_writers" as const,
    resumeAction: { label: "Go", target },
    threadId: threadId === null ? null : ThreadId.make(threadId),
  });

  it("opens the Plugins page of the board's environment for a settings action", () => {
    expect(attentionResumeTarget(row("settings"), board)).toEqual({
      to: "/plugins",
      search: { machine: "remote" },
    });
  });

  it("opens the row's thread, or the board, on the board's environment", () => {
    expect(attentionResumeTarget(row("thread", "thread-1"), board)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: "thread-1" },
    });
    expect(attentionResumeTarget(row("board"), board)).toEqual({ to: "/board", search: board });
  });

  it("opens the board without a project for a row about every project", () => {
    expect(attentionResumeTarget(row("board"), { ...board, projectId: null })).toEqual({
      to: "/board",
      search: {},
    });
  });

  it("opens the board's decisions view for a conflicted decision", () => {
    expect(attentionResumeTarget({ ...row("board"), kind: "decision_conflict" }, board)).toEqual({
      to: "/board",
      search: { ...board, view: "decisions" },
    });
  });

  it("has nowhere to go for a thread action without a thread", () => {
    expect(attentionResumeTarget(row("thread"), board)).toBeNull();
  });

  it("opens a plugin's screen on the board's environment and project, with the tab and record named", () => {
    const plugin = (patch: { readonly tab?: string; readonly recordId?: string }) =>
      ({
        kind: "budget_breach",
        resumeAction: { label: "Open item", target: "plugin", pluginId: "learning", ...patch },
        threadId: ThreadId.make("thread-1"),
      }) as const;
    expect(attentionResumeTarget(plugin({ tab: "items", recordId: "12" }), board)).toEqual({
      to: "/plugins/$pluginId",
      params: { pluginId: "learning" },
      search: { machine: "remote", projectId: "project-1", tab: "items", recordId: "12" },
    });
    // Without a tab or record the screen opens on its default tab, on the board's project.
    expect(attentionResumeTarget(plugin({}), board)).toStrictEqual({
      to: "/plugins/$pluginId",
      params: { pluginId: "learning" },
      search: { machine: "remote", projectId: "project-1" },
    });
    // A row about every project names no project.
    expect(attentionResumeTarget(plugin({}), { ...board, projectId: null })).toStrictEqual({
      to: "/plugins/$pluginId",
      params: { pluginId: "learning" },
      search: { machine: "remote" },
    });
  });
});

describe("boardAttentionTitle", () => {
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("project-1");
  const projectLabel = () => "app";
  const title = (
    fields: {
      threadId: string | null;
      threadTitle: string | null;
      projectId: ProjectId | null;
    },
    environmentLabel: (id: EnvironmentId) => string | undefined = () => undefined,
  ) => {
    const [row] = kanbanAttentionStripRows([
      {
        source: "flag" as const,
        id: "flag:1",
        threadId: fields.threadId === null ? null : ThreadId.make(fields.threadId),
        threadTitle: fields.threadTitle,
        kind: "two_writers" as const,
        text: "Something waits.",
        resumeAction: { label: "Open thread", target: "thread" as const },
        since: "2026-10-13T08:00:00.000Z",
        projectId: fields.projectId,
        environmentId,
      },
    ]);
    return boardAttentionTitle(row!, projectLabel, environmentLabel);
  };

  it("keeps a thread row a thread row, untitled or not", () => {
    expect(title({ threadId: "thread-1", threadTitle: "Fix login", projectId })).toBe("Fix login");
    expect(title({ threadId: "thread-1", threadTitle: null, projectId })).toBe("Untitled thread");
  });

  it("names the project for a project row, and every project for an environment's policy", () => {
    expect(title({ threadId: null, threadTitle: null, projectId })).toBe("app");
    expect(title({ threadId: null, threadTitle: null, projectId: null })).toBe("Every project");
  });

  it("names the environment of a policy row once the board spans several, as cards do", () => {
    const spans = (id: EnvironmentId) => (id === environmentId ? "Laptop" : "Server");
    expect(title({ threadId: null, threadTitle: null, projectId: null }, spans)).toBe(
      "Every project · Laptop",
    );
    expect(title({ threadId: null, threadTitle: null, projectId }, spans)).toBe("app");
    expect(title({ threadId: "thread-1", threadTitle: "Fix login", projectId: null }, spans)).toBe(
      "Fix login",
    );
  });
});

describe("boardChanges", () => {
  it("counts no change for a board's first snapshot or the same one again, and one per later one", () => {
    const [first, second, third] = [{ n: 1 }, { n: 2 }, { n: 3 }];
    let state = boardChanges<{ n: number }>({ snapshot: undefined, changes: 0 }, undefined);
    const counts = [first, first, second, undefined, second, third].map(
      (snapshot) => (state = boardChanges(state, snapshot)).changes,
    );
    expect(counts).toEqual([0, 0, 1, 1, 1, 2]);
  });
});

describe("findDecisionSearch", () => {
  const environmentId = EnvironmentId.make("env-1");
  const thread = { environmentId, projectId: ProjectId.make("thread-project") };
  const board = { environmentId, projectId: ProjectId.make("board-project"), view: undefined };

  it("opens the decisions of the thread's project, over what the board showed", () => {
    expect(findDecisionSearch(board, thread)).toEqual({
      view: "decisions",
      environmentId,
      projectId: thread.projectId,
    });
  });

  it("keeps the board's project without a thread, and leaves the pick to the board otherwise", () => {
    expect(findDecisionSearch(board, null)).toEqual({
      view: "decisions",
      environmentId,
      projectId: board.projectId,
    });
    expect(findDecisionSearch({ diff: "1" }, undefined)).toEqual({ view: "decisions" });
  });
});

describe("validateBoardSearch", () => {
  /** What the board reads after a link wrote `search` into the URL and the router read it back. */
  const throughUrl = (search: Record<string, unknown>) =>
    validateBoardSearch(defaultParseSearch(defaultStringifySearch(search)));

  it("brings back the decision a link opens, by its category and id", () => {
    expect(
      throughUrl({ projectId: "p-1", view: "decisions", decision: "storage/use-sqlite" }),
    ).toStrictEqual({ projectId: "p-1", view: "decisions", decision: "storage/use-sqlite" });
  });

  it("drops a decision that is not a category and id, and keys the board does not read", () => {
    for (const decision of ["use-sqlite", "Storage/Use SQLite", "a/b/c", "", 12]) {
      expect(validateBoardSearch({ view: "decisions", decision, other: "x" })).toStrictEqual({
        view: "decisions",
      });
    }
  });
});

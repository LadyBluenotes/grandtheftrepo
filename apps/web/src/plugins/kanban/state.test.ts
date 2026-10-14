import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attentionResumeTarget, buildIssuePrompt } from "./state";

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
const decision = (category: string, stance: "for" | "against") => ({
  category,
  id: `${category}-${stance}`,
  stance,
  title: "Some call",
  why: "A long justification that must not reach the prompt.",
  issues: [issue.id],
  by: "user",
  at: "2026-10-12T00:00:00.000Z",
});

describe("buildIssuePrompt", () => {
  it("indexes decisions by category without pasting their bodies", () => {
    const prompt = buildIssuePrompt(
      issue,
      [decision("auth", "for"), decision("auth", "against"), decision("general", "for")],
      [
        { category: "auth", count: 12 },
        { category: "general", count: 7 },
      ],
    );
    expect(prompt.startsWith("Fix login redirect\n\nLoops on an expired cookie.")).toBe(true);
    expect(prompt).toContain(
      "Decisions on this ticket (3): auth: for 1, against 1; general: for 1, against 0",
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

  it("has nowhere to go for a thread action without a thread", () => {
    expect(attentionResumeTarget(row("thread"), board)).toBeNull();
  });
});

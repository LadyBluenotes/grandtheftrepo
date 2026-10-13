import { ProjectId, type KnowledgeEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { acceptInput, draftProblem, groupKnowledge, needsInstall } from "./state";

const projectId = ProjectId.make("project-1");

const entry = (
  id: number,
  key: string,
  state: KnowledgeEntry["state"],
  at: { readonly created: string; readonly retired?: string },
): KnowledgeEntry => ({
  id,
  projectId,
  key,
  title: `Title ${key}`,
  body: `Body ${key}`,
  state,
  source: { kind: "person" },
  createdAt: at.created,
  acceptedAt: state === "draft" ? null : at.created,
  retiredAt: at.retired ?? null,
});

describe("groupKnowledge", () => {
  it("queues drafts oldest first, lists pages in index order and the latest retired first", () => {
    const groups = groupKnowledge([
      entry(1, "zeta", "accepted", { created: "2026-10-01T00:00:00.000Z" }),
      entry(2, "late", "draft", { created: "2026-10-03T00:00:00.000Z" }),
      entry(3, "alpha", "accepted", { created: "2026-10-02T00:00:00.000Z" }),
      entry(4, "early", "draft", { created: "2026-10-01T00:00:00.000Z" }),
      entry(5, "old", "retired", {
        created: "2026-09-01T00:00:00.000Z",
        retired: "2026-09-02T00:00:00.000Z",
      }),
      entry(6, "recent", "retired", {
        created: "2026-09-01T00:00:00.000Z",
        retired: "2026-10-02T00:00:00.000Z",
      }),
    ]);
    expect(groups.drafts.map((page) => page.key)).toEqual(["early", "late"]);
    expect(groups.accepted.map((page) => page.key)).toEqual(["alpha", "zeta"]);
    expect(groups.retired.map((page) => page.key)).toEqual(["recent", "old"]);
  });
});

describe("draftProblem", () => {
  it("accepts what the server accepts and names the first field it would refuse", () => {
    expect(draftProblem("Running the tests", "Use vp.")).toBeNull();
    expect(draftProblem("  Running the tests  ", "\nUse vp.\n")).toBeNull();
    expect(draftProblem("   ", "Use vp.")).toBe("The title is empty.");
    expect(draftProblem("Two\nlines", "Use vp.")).toBe(
      "The title is one line of at most 200 characters.",
    );
    expect(draftProblem("x".repeat(201), "Use vp.")).toBe(
      "The title is one line of at most 200 characters.",
    );
    expect(draftProblem("Running the tests", " ")).toBe("The body is empty.");
    expect(draftProblem("Running the tests", "x".repeat(4_000))).toBeNull();
    expect(draftProblem("Running the tests", "x".repeat(4_001))).toBe(
      "The body is at most 4,000 characters.",
    );
  });
});

describe("acceptInput", () => {
  const draft = { id: 7, title: "Running the tests", body: "Use vp." };

  it("sends only the fields the person changed, trimmed", () => {
    expect(acceptInput(draft, "Running the tests", "Use vp.")).toEqual({ id: 7 });
    expect(acceptInput(draft, " Running the tests ", "Use vp.\n")).toEqual({ id: 7 });
    expect(acceptInput(draft, "Testing", "Use vp.")).toEqual({ id: 7, title: "Testing" });
    expect(acceptInput(draft, "Running the tests", " Use vp test run. ")).toEqual({
      id: 7,
      body: "Use vp test run.",
    });
  });
});

describe("needsInstall", () => {
  it("is true once any agent's delivery is not ok", () => {
    const ok = { agent: "claude" as const, status: "ok" as const, path: "/p/CLAUDE.md" };
    expect(needsInstall([])).toBe(false);
    expect(needsInstall([ok])).toBe(false);
    expect(needsInstall([ok, { agent: "codex", status: "drifted", path: "/p/AGENTS.md" }])).toBe(
      true,
    );
    expect(needsInstall([{ ...ok, status: "missing" }])).toBe(true);
  });
});

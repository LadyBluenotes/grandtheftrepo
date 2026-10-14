import { ProjectId, type Prompt } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { promptProblem, promptRows } from "./promptState";

const prompt = (patch: Partial<Prompt>): Prompt => ({
  id: 1,
  projectId: ProjectId.make("project-1"),
  kind: "prompt",
  state: "active",
  origin: "user",
  title: "Review the diff",
  body: "Read every changed file.",
  version: 1,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("promptRows", () => {
  const prompts = [
    prompt({ id: 1, updatedAt: "2026-10-01T00:00:00.000Z" }),
    prompt({
      id: 2,
      state: "proposed",
      title: "Run the tests",
      body: "Run vp test for the CHANGED files.",
      updatedAt: "2026-10-03T00:00:00.000Z",
    }),
    prompt({ id: 3, state: "archived", title: "Old", updatedAt: "2026-10-02T00:00:00.000Z" }),
  ];

  it("keeps every state, most recently updated first, with no filter", () => {
    expect(promptRows(prompts, { state: null, query: "" }).map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it("keeps prompts holding every word of the search in the title or body, in any case", () => {
    expect(promptRows(prompts, { state: null, query: " changed  FILE " }).map((p) => p.id)).toEqual(
      [2, 3, 1],
    );
    expect(promptRows(prompts, { state: null, query: "READ changed" }).map((p) => p.id)).toEqual([
      3, 1,
    ]);
    expect(promptRows(prompts, { state: null, query: "deploy" })).toEqual([]);
  });

  it("narrows to one state", () => {
    expect(promptRows(prompts, { state: "active", query: "" }).map((p) => p.id)).toEqual([1]);
    expect(promptRows(prompts, { state: "archived", query: "changed" }).map((p) => p.id)).toEqual([
      3,
    ]);
  });
});

describe("promptProblem", () => {
  it("accepts a one-line title and a body within the limit", () => {
    expect(promptProblem(" Review ", " Read it. ")).toBeNull();
  });

  it("names what is wrong", () => {
    expect(promptProblem(" ", "Body")).toBe("The title is empty.");
    expect(promptProblem("Two\nlines", "Body")).toBe(
      "The title is one line of at most 200 characters.",
    );
    expect(promptProblem("Title", "")).toBe("The body is empty.");
    expect(promptProblem("Title", "x".repeat(10_001))).toBe(
      "The body is at most 10,000 characters.",
    );
  });
});

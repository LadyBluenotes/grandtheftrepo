import { EnvironmentId, ProjectId, type Prompt, type PromptSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { noteSavedPromptInserted, savedPromptMenuItems, takeSentPrompts } from "./composerPrompts";

const environmentId = EnvironmentId.make("environment-1");

const summary = (patch: Partial<PromptSummary>): PromptSummary => ({
  id: 1,
  projectId: ProjectId.make("project-1"),
  kind: "prompt",
  state: "active",
  origin: "user",
  title: "Review the diff",
  preview: "Read every changed file.",
  version: 1,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

const prompt = (patch: Partial<Prompt>): Prompt => {
  const { preview: _preview, ...fields } = summary({});
  return { ...fields, body: "Read every changed file.", ...patch };
};

describe("savedPromptMenuItems", () => {
  const prompts = [
    summary({ id: 1, title: "Review the diff", useCount: 2 }),
    summary({ id: 2, title: "Fix flaky tests", useCount: 7 }),
    summary({
      id: 3,
      title: "Write release notes",
      useCount: 2,
      lastUsedAt: "2026-10-09T00:00:00Z",
    }),
    summary({ id: 4, title: "Review the plan", useCount: 2, lastUsedAt: "2026-10-02T00:00:00Z" }),
  ];
  const ids = (query: string) =>
    savedPromptMenuItems(environmentId, prompts, query).map((item) => item.prompt.id);

  it("orders the most used first, then the most recently used, then by title", () => {
    expect(ids("")).toEqual([2, 3, 4, 1]);
  });

  it("keeps titles holding every word of the query in any case", () => {
    expect(ids("REVIEW")).toEqual([4, 1]);
    expect(ids("fla")).toEqual([2]);
    expect(ids("notes")).toEqual([3]);
    expect(ids("deploy")).toEqual([]);
  });

  it("reads dashes and underscores in the one-token query as word breaks", () => {
    expect(ids("review-diff")).toEqual([1]);
    expect(ids("tests_fix")).toEqual([2]);
    expect(ids("review-notes")).toEqual([]);
  });

  it("does not match the preview", () => {
    expect(ids("changed")).toEqual([]);
  });

  it("labels an item with the title and describes it with the preview's first line", () => {
    const [item] = savedPromptMenuItems(
      environmentId,
      [summary({ preview: "\n  Read every changed file.\nThen run the tests." })],
      "",
    );
    expect(item).toMatchObject({
      type: "saved-prompt",
      label: "Review the diff",
      description: "Read every changed file.",
    });
  });
});

describe("takeSentPrompts", () => {
  const review = prompt({ id: 1, body: "Read every changed file.\nList what is missing." });
  const fix = prompt({ id: 2, title: "Fix", body: "Fix the flaky test." });

  it("counts a picked prompt the sent message still holds, once", () => {
    noteSavedPromptInserted("draft-a", environmentId, review);
    noteSavedPromptInserted("draft-a", environmentId, review);
    const sent = takeSentPrompts(
      "draft-a",
      "For PR 12:  Read every changed file.\n\nList what is missing. Thanks",
    );
    expect(sent.map((pick) => pick.prompt.id)).toEqual([1]);
    expect(takeSentPrompts("draft-a", "Read every changed file. List what is missing.")).toEqual(
      [],
    );
  });

  it("matches the body as it was inserted, so a later version does not count an older one", () => {
    noteSavedPromptInserted("draft-f", environmentId, review);
    noteSavedPromptInserted("draft-f", environmentId, { ...review, body: "Read the diff." });
    expect(takeSentPrompts("draft-f", "Read every changed file. List what is missing.")).toEqual(
      [],
    );
  });

  it("does not count a pick whose body was edited or removed before sending", () => {
    noteSavedPromptInserted("draft-b", environmentId, review);
    noteSavedPromptInserted("draft-b", environmentId, fix);
    expect(
      takeSentPrompts("draft-b", "Read every changed file. Fix the flaky test.").map(
        (pick) => pick.prompt.id,
      ),
    ).toEqual([2]);
  });

  it("keeps each draft's picks apart", () => {
    noteSavedPromptInserted("draft-c", environmentId, fix);
    expect(takeSentPrompts("draft-d", "Fix the flaky test.")).toEqual([]);
    expect(takeSentPrompts("draft-c", "Fix the flaky test.").map((p) => p.prompt.id)).toEqual([2]);
  });

  it("counts nothing for a message sent without a pick", () => {
    expect(takeSentPrompts("draft-e", "Fix the flaky test.")).toEqual([]);
  });
});

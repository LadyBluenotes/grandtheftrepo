import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { KanbanIssue } from "./kanban.ts";

const decodeIssue = Schema.decodeUnknownSync(Schema.toCodecJson(KanbanIssue));

describe("KanbanIssue", () => {
  it("reads an issue from a server that predates findings as one with none", () => {
    const issue = decodeIssue({
      id: "fix-login",
      title: "Fix login",
      status: "todo",
      priority: "p2",
      labels: [],
      verification: "unverified",
      tier: null,
      blocked: null,
      reopened: null,
      threads: [],
      createdAt: "2026-10-12T13:00:00.000Z",
      createdBy: "user",
      updatedAt: "2026-10-12T13:00:00.000Z",
      doneAt: null,
      archivedAt: null,
      criteria: [],
      description: "",
      log: [{ at: "2026-10-12T13:00:00.000Z", by: "user", kind: "note", text: "Filed" }],
    });
    expect(issue.findings).toEqual([]);
  });
});

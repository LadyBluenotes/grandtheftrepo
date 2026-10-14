import {
  CAPTURED_RECORD_OUTPUT_KEY,
  CapturedRecord,
  type KanbanFindingPlacement,
  type KnowledgeEntry,
  type LearningCorrection,
  type OrchestrationV2TurnItem,
  type Prompt,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { projectTurnItemForWire } from "../orchestration-v2/WireProjection.ts";
import { capturedRecordFromToolItem } from "./capturedRecords.ts";

const at = "2026-10-14T09:00:00.000Z";
const decodeCapturedRecord = Schema.decodeUnknownSync(CapturedRecord);

const finding = {
  projectId: "project-1",
  issueId: "flaky-login-test",
  finding: {
    id: "f-1",
    title: "Login test is flaky",
    evidence: "Failed twice in ten runs",
    truthStatus: "reproduced",
    scopeRelation: "pre_existing",
    disposition: "open",
    proposedBy: "thread:thread-1",
    proposedAt: at,
    threadId: "thread-1",
    review: null,
  },
} satisfies typeof KanbanFindingPlacement.Encoded;

const correction = {
  id: 7,
  projectId: "project-1",
  threadId: "thread-1",
  failureKind: "manual",
  causeClass: "unclassified",
  declaredMode: "defect",
  description: "Shipped the migration without its rollback",
  sourceEventIds: [],
  sourceKey: null,
  classifiedAt: null,
  classificationReason: null,
  createdAt: at,
  updatedAt: at,
} satisfies typeof LearningCorrection.Encoded;

const page = {
  id: 3,
  projectId: "project-1",
  key: "release-steps",
  title: "How a release is cut",
  body: "Tag, then build.",
  state: "draft",
  source: { kind: "agent", threadId: "thread-1" },
  createdAt: at,
  acceptedAt: null,
  retiredAt: null,
} satisfies typeof KnowledgeEntry.Encoded;

const prompt = {
  id: 12,
  projectId: "project-1",
  kind: "workflow",
  state: "proposed",
  origin: "user",
  title: "Cut a release",
  version: 1,
  useCount: 0,
  lastUsedAt: null,
  createdAt: at,
  updatedAt: at,
  body: "1. Tag\n2. Build",
} satisfies typeof Prompt.Encoded;

/** What the MCP server answers with: the result as JSON text, and as structured content. */
const mcpResult = (result: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});

const cases = [
  {
    name: "kanban_write decision.create",
    toolName: "mcp__t3-code__kanban_write",
    input: {
      action: "decision.create",
      category: "storage",
      title: "Keep findings in issue frontmatter",
      state: "proposed",
      why: "One file per issue",
    },
    result: "keep-findings-in-issue-frontmatter",
    record: {
      kind: "decision",
      id: "storage/keep-findings-in-issue-frontmatter",
      title: "Keep findings in issue frontmatter",
      state: "proposed",
      projectId: null,
    },
  },
  {
    name: "finding_capture",
    toolName: "t3-code.finding_capture",
    input: { title: "Login test is flaky", searchId: "s-1" },
    result: finding,
    record: {
      kind: "finding",
      id: "f-1",
      title: "Login test is flaky",
      state: "open",
      projectId: "project-1",
      issueId: "flaky-login-test",
    },
  },
  {
    name: "learning_correction_add",
    toolName: "mcp_t3_code_learning_correction_add",
    input: { description: correction.description, declaredMode: "defect" },
    result: correction,
    record: {
      kind: "correction",
      id: "7",
      title: "Shipped the migration without its rollback",
      state: "defect",
      projectId: "project-1",
    },
  },
  {
    name: "knowledge_propose",
    toolName: "t3-code-thread_1_knowledge_propose",
    input: { key: "release-steps", title: page.title, body: page.body },
    result: page,
    record: {
      kind: "knowledge",
      id: "3",
      title: "How a release is cut",
      state: "draft",
      projectId: "project-1",
    },
  },
  {
    name: "prompt_save",
    toolName: "prompt_save",
    input: { searchId: "s-2", kind: "workflow", title: prompt.title, body: prompt.body },
    result: prompt,
    record: {
      kind: "prompt",
      id: "12",
      title: "Cut a release",
      state: "proposed",
      projectId: "project-1",
    },
  },
] as const;

const item = (fields: {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status?: "completed" | "failed";
}) => ({
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: fields.status ?? ("completed" as const),
  title: null,
  toolName: fields.toolName,
  input: fields.input,
  output: fields.output,
  startedAt: DateTime.makeUnsafe(at),
  completedAt: DateTime.makeUnsafe(at),
  updatedAt: DateTime.makeUnsafe(at),
});

/** The record a client reads from the item as it crosses the wire, if any. */
const wireRecord = (toolItem: OrchestrationV2TurnItem) => {
  const projected = projectTurnItemForWire(toolItem);
  const output: unknown = JSON.parse(
    JSON.stringify(projected.type === "dynamic_tool" ? (projected.output ?? null) : null),
  );
  return Predicate.isObject(output) ? output[CAPTURED_RECORD_OUTPUT_KEY] : undefined;
};

describe("capturedRecordFromToolItem", () => {
  it.each(cases)("reads $name however the provider stored the answer", (c) => {
    const result = mcpResult(c.result);
    const acpBlocks = result.content.map((block) => ({ type: "content", content: block }));
    for (const output of [result.content, result.structuredContent, result, acpBlocks]) {
      expect(capturedRecordFromToolItem(item({ ...c, output }))).toEqual(c.record);
    }
  });

  it("records only a decision from kanban_write", () => {
    const output = mcpResult("flaky-login-test").content;
    const issue = { action: "issue.create", title: "Flaky login test" };
    const note = { action: "decision.update", category: "storage", id: "x", title: "Renamed" };
    for (const input of [issue, note]) {
      expect(
        capturedRecordFromToolItem(item({ toolName: "t3-code.kanban_write", input, output })),
      ).toBeUndefined();
    }
  });

  it("records nothing for a failed call, an error result, or another server's tool", () => {
    const failure = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
            message: "Search first.",
          }),
        },
      ],
      isError: true,
    };
    const [, findingCase] = cases;
    const failed = [
      item({ ...findingCase, output: mcpResult(finding).content, status: "failed" }),
      item({ ...findingCase, output: failure }),
      item({ ...findingCase, output: { error: "Search first.", result: failure.content } }),
      item({ ...findingCase, toolName: "mcp__other__finding_capture", output: finding }),
    ];
    for (const failedItem of failed) expect(wireRecord(failedItem)).toBeUndefined();
  });

  it("keeps the record when an item already projected for the wire is projected again", () => {
    for (const c of cases) {
      const once = projectTurnItemForWire(item({ ...c, output: mcpResult(c.result).content }));
      expect(projectTurnItemForWire(once)).toEqual(once);
      // Projected a second time, the record is still there for a client to read.
      expect(wireRecord(once)).toEqual(c.record);
    }
  });

  it("puts the record on the wire for a client to decode", () => {
    const [decisionCase] = cases;
    const wire = wireRecord(
      item({ ...decisionCase, output: mcpResult(decisionCase.result).content }),
    );
    expect(decodeCapturedRecord(wire)).toEqual(decisionCase.record);
  });
});

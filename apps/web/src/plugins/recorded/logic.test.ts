import {
  CAPTURED_RECORD_OUTPUT_KEY,
  type CapturedRecord,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { capturedRecordsByRun, capturedRecordTarget, groupCapturedRecords } from "./logic";

const threadId = ThreadId.make("thread-1");
const runA = RunId.make("run-a");
const runB = RunId.make("run-b");
const now = DateTime.makeUnsafe("2026-10-14T09:00:00.000Z");

const decision: CapturedRecord = {
  kind: "decision",
  id: "storage/keep-findings-in-frontmatter",
  title: "Keep findings in frontmatter",
  state: "accepted",
  projectId: null,
};
const correction: CapturedRecord = {
  kind: "correction",
  id: "7",
  title: "Shipped the migration without its rollback",
  state: "defect",
  projectId: ProjectId.make("project-1"),
};
const finding: CapturedRecord = {
  kind: "finding",
  id: "f-1",
  title: "Login test is flaky",
  state: "open",
  projectId: ProjectId.make("project-1"),
  issueId: "flaky-login-test",
};

let ordinal = 0;
const base = (id: string, runId: RunId) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: ordinal++,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});
const userMessage = (id: string, runId: RunId): OrchestrationV2TurnItem => ({
  ...base(id, runId),
  type: "user_message",
  messageId: MessageId.make(id),
  inputIntent: "turn_start",
  text: id,
  attachments: [],
  createdBy: "user",
  creationSource: "web",
});
const reply = (id: string, runId: RunId): OrchestrationV2TurnItem => ({
  ...base(id, runId),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text: id,
  streaming: false,
});
/** A tool call as it arrives over the wire, with the record the server read from it. */
const toolCall = (
  id: string,
  runId: RunId,
  toolName: string,
  record: CapturedRecord | null,
  status: "completed" | "failed" = "completed",
): OrchestrationV2TurnItem => ({
  ...base(id, runId),
  status,
  type: "dynamic_tool",
  toolName,
  input: {},
  ...(record === null ? {} : { output: { [CAPTURED_RECORD_OUTPUT_KEY]: record } }),
});

const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
  visibleTurnItems: [
    userMessage("ask-a", runA),
    toolCall("decide", runA, "mcp__t3-code__kanban_write", decision),
    toolCall("read", runA, "mcp__t3-code__kanban_list", null),
    toolCall("flaky", runA, "mcp__t3-code__finding_capture", finding, "failed"),
    toolCall("correct", runA, "mcp__t3-code__learning_correction_add", correction),
    toolCall("correct-again", runA, "mcp__t3-code__learning_correction_add", correction),
    reply("answer-a", runA),
    userMessage("ask-b", runB),
    toolCall("search", runB, "mcp__t3-code__finding_search", null),
    reply("answer-b", runB),
  ].map((item, position) => ({
    item,
    position,
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
  })),
  optimisticMessages: [],
});

describe("capturedRecordsByRun", () => {
  it("collects each run's completed captures once, in the order they were made", () => {
    const byRun = capturedRecordsByRun(timelineEntries);
    expect(byRun.get(runA)).toEqual([decision, correction]);
    expect(byRun.has(runB)).toBe(false);
  });

  it("groups a run's records by kind in the card's fixed order", () => {
    expect(groupCapturedRecords([correction, finding, decision])).toEqual([
      { kind: "decision", label: "Decisions", records: [decision] },
      { kind: "finding", label: "Findings", records: [finding] },
      { kind: "correction", label: "Corrections", records: [correction] },
    ]);
  });

  it("gives the records to the run's last reply, and none to a turn that recorded nothing", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const recordsOf = (messageId: string) =>
      rows.flatMap((row) =>
        row.kind === "message" && row.message.id === messageId ? [row.capturedRecords] : [],
      );
    expect(recordsOf("answer-a")).toEqual([[decision, correction]]);
    expect(recordsOf("answer-b")).toEqual([undefined]);
    expect(recordsOf("ask-a")).toEqual([undefined]);
  });
});

describe("capturedRecordTarget", () => {
  const thread = { environmentId: EnvironmentId.make("remote"), projectId: ProjectId.make("p-2") };

  it("opens a decision's drawer in the board's decisions, on the thread's project", () => {
    expect(capturedRecordTarget(decision, thread)).toEqual({
      to: "/board",
      search: {
        environmentId: "remote",
        projectId: "p-2",
        view: "decisions",
        decision: "storage/keep-findings-in-frontmatter",
      },
    });
  });

  it("opens a finding's issue panel, and a prompt in its drawer, on the record's project", () => {
    expect(capturedRecordTarget(finding, thread)).toEqual({
      to: "/board",
      search: { environmentId: "remote", projectId: "project-1", issue: "flaky-login-test" },
    });
    const prompt = { ...correction, kind: "prompt" as const, id: "12", state: "proposed" };
    expect(capturedRecordTarget(prompt, thread)).toEqual({
      to: "/plugins/$pluginId",
      params: { pluginId: "learning" },
      search: { machine: "remote", projectId: "project-1", tab: "prompts", recordId: "12" },
    });
  });

  it("opens nothing without a project", () => {
    expect(capturedRecordTarget(decision, { ...thread, projectId: null })).toBeNull();
  });
});

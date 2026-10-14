import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type RoutingMismatch,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as Attention from "../Attention.ts";
import { attentionRows, projectsAttentionRows } from "./attentionRows.ts";
import { projectA, projectB, thread } from "./writerFixtures.ts";

const epoch = Date.parse("2026-10-12T00:00:00.000Z");
const at = (seconds: number) => DateTime.makeUnsafe(epoch + seconds * 1000);
const iso = (seconds: number) => DateTime.formatIso(at(seconds));

/** A thread in project A waiting on a request of `kind`, asked `seconds` after the epoch. */
const asking = (
  id: string,
  kind: OrchestrationV2PendingRuntimeRequestSummary["kind"],
  seconds = 0,
): OrchestrationV2ThreadShell => ({
  ...thread(id, { status: "waiting" }),
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`request-${id}`),
    kind,
    createdAt: at(seconds),
  },
});

const flag = (overrides: Partial<Attention.OpenFlag> = {}): Attention.OpenFlag => ({
  id: 1,
  pluginId: "kanban",
  threadId: "a",
  kind: "two_writers",
  text: "2 threads are writing to this project at once.",
  resumeAction: { label: "Open thread", target: "thread" },
  raisedAt: iso(0),
  ...overrides,
});

const mismatch = (threadId: string, seconds = 0): RoutingMismatch => ({
  threadId: ThreadId.make(threadId),
  tier: "cheap",
  recommended: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" },
  observed: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  at: iso(seconds),
  flag: `Thread ${threadId} was recommended the cheap tier but ran gpt-5.4 on codex.`,
});

const rows = (input: Partial<Parameters<typeof attentionRows>[0]>) =>
  attentionRows({ projectId: projectA, threads: [], flags: [], mismatches: [], ...input });

describe("attentionRows", () => {
  it("shows questions and permissions, and nothing for requests no person answers", () => {
    const result = rows({
      threads: [
        asking("user-input", "user_input", 1),
        asking("elicitation", "mcp-elicitation", 2),
        asking("command", "command", 3),
        asking("file-read", "file-read", 4),
        asking("file-change", "file-change", 5),
        asking("permission", "permission", 6),
        asking("tool", "dynamic_tool_call", 7),
        asking("auth", "auth_refresh", 8),
        thread("idle", { status: "idle" }),
      ],
    });
    assert.deepEqual(
      result.map((row) => `${row.threadId} ${row.kind}`),
      [
        "user-input question",
        "elicitation question",
        "command permission",
        "file-read permission",
        "file-change permission",
        "permission permission",
      ],
    );
    assert.deepEqual(result[0], {
      source: "request",
      id: "request:request-user-input",
      threadId: ThreadId.make("user-input"),
      threadTitle: "Thread user-input",
      kind: "question",
      text: "The agent asked you a question.",
      resumeAction: { label: "Open thread", target: "thread" },
      since: iso(1),
    });
  });

  it("leaves out a settled thread's stale request but keeps its flag, and all of an archived one", () => {
    const settledAt = at(0);
    const result = rows({
      threads: [
        { ...asking("settled", "user_input"), settledOverride: "settled", settledAt },
        { ...asking("auto-settled", "permission"), settledAt },
        { ...asking("archived", "user_input"), archivedAt: settledAt },
      ],
      flags: [
        flag({ id: 1, threadId: "settled" }),
        flag({ id: 2, threadId: "archived", kind: "stale_review" }),
      ],
    });
    assert.deepEqual(
      result.map((row) => [row.source, row.id, row.threadId]),
      [["flag", "flag:1", "settled"]],
    );
  });

  it("keeps flags on the project's threads or keyed to the project, and leaves out the rest", () => {
    const budget = {
      pluginId: "telemetry",
      kind: "budget_breach",
      resumeAction: { label: "Open budgets", target: "settings" },
    } as const;
    const result = rows({
      // The project's threads; "other" is a thread of another project.
      threads: [thread("a")],
      flags: [
        flag({ id: 1, threadId: "a" }),
        flag({ id: 2, threadId: "other" }),
        flag({ id: 3, threadId: `budget:7:${projectA}`, text: "Over budget in A.", ...budget }),
        flag({ id: 4, threadId: `budget:7:${projectB}`, text: "Over budget in B.", ...budget }),
      ],
    });
    assert.deepEqual(
      result.map((row) => [
        row.id,
        row.threadId,
        row.threadTitle,
        row.kind,
        row.resumeAction.target,
      ]),
      [
        ["flag:1", "a", "Thread a", "two_writers", "thread"],
        ["flag:3", null, null, "budget_breach", "settings"],
      ],
    );
  });

  it("keeps a delivery drift flag whose key has the project as a segment, for that project only", () => {
    const drift = {
      kind: "delivery_drift",
      resumeAction: { label: "Reinstall", target: "settings" },
    } as const;
    const result = rows({
      flags: [
        flag({
          id: 1,
          pluginId: "policy",
          threadId: `policy:${projectA}:claude:/home/me/.claude/CLAUDE.md`,
          text: 'The "review" policy block was edited.',
          ...drift,
        }),
        flag({
          id: 2,
          pluginId: "knowledge",
          threadId: `knowledge:${projectA}:page:tests:/work/a/.knowledge/tests.md`,
          text: 'The knowledge page "tests" was removed.',
          ...drift,
        }),
        flag({
          id: 3,
          pluginId: "policy",
          threadId: `policy:${projectB}:claude:/home/me/.claude/CLAUDE.md`,
          text: "Another project's block.",
          ...drift,
        }),
        flag({
          id: 4,
          pluginId: "knowledge",
          threadId: `knowledge:${projectB}:page:tests:/work/b/.knowledge/tests.md`,
          text: "Another project's page.",
          ...drift,
        }),
      ],
    });
    assert.deepEqual(
      result.map((row) => [row.id, row.threadId, row.threadTitle, row.kind, row.text]),
      [
        ["flag:1", null, null, "delivery_drift", 'The "review" policy block was edited.'],
        ["flag:2", null, null, "delivery_drift", 'The knowledge page "tests" was removed.'],
      ],
    );
  });

  it("lists a drift flag of an environment-wide policy on every project's board", () => {
    const environmentWide = flag({
      id: 1,
      pluginId: "policy",
      kind: "delivery_drift",
      threadId: "policy:*:claude:/home/me/.claude/CLAUDE.md",
      text: 'The "ponytail" policy block was edited.',
      resumeAction: { label: "Reinstall", target: "settings" },
    });
    for (const projectId of [projectA, projectB]) {
      assert.deepEqual(
        rows({ projectId, flags: [environmentWide] }).map((row) => [
          row.id,
          row.threadId,
          row.kind,
          row.text,
        ]),
        [["flag:1", null, "delivery_drift", 'The "ponytail" policy block was edited.']],
      );
    }
  });

  it("shows a routing mismatch on one of the project's threads as a flag naming the thread", () => {
    const result = rows({
      threads: [thread("a")],
      mismatches: [mismatch("a", 5), mismatch("gone", 6)],
    });
    assert.deepEqual(result, [
      {
        source: "flag",
        id: `routing:a:${iso(5)}`,
        threadId: ThreadId.make("a"),
        threadTitle: "Thread a",
        kind: "routing_mismatch",
        text: "Thread a was recommended the cheap tier but ran gpt-5.4 on codex.",
        resumeAction: { label: "Open thread", target: "thread" },
        since: iso(5),
      },
    ]);
  });

  it("orders every source oldest first, then by id", () => {
    const result = rows({
      threads: [asking("a", "user_input", 30), thread("b")],
      flags: [
        flag({ id: 12, threadId: "b", raisedAt: iso(10) }),
        flag({ id: 11, threadId: "a", kind: "stale_review", raisedAt: iso(10) }),
      ],
      mismatches: [mismatch("b", 20)],
    });
    assert.deepEqual(
      result.map((row) => row.id),
      ["flag:11", "flag:12", `routing:b:${iso(20)}`, "request:request-a"],
    );
  });
});

describe("projectsAttentionRows", () => {
  it("lists an environment-wide policy flag once, with no project, among each project's rows", () => {
    const drift = {
      pluginId: "policy",
      kind: "delivery_drift",
      resumeAction: { label: "Reinstall", target: "settings" },
    } as const;
    const result = projectsAttentionRows({
      projects: [
        { projectId: projectA, threads: [asking("a", "user_input", 30)], mismatches: [] },
        {
          projectId: projectB,
          threads: [thread("b", { projectId: projectB })],
          mismatches: [mismatch("b", 20)],
        },
      ],
      flags: [
        flag({ id: 1, threadId: "policy:*:claude:/home/me/.claude/CLAUDE.md", ...drift }),
        flag({ id: 2, threadId: `policy:${projectB}:claude:/home/me/.claude/CLAUDE.md`, ...drift }),
        flag({ id: 3, threadId: "b", raisedAt: iso(10) }),
      ],
    });
    assert.deepEqual(
      result.map((row) => [row.id, row.projectId]),
      [
        ["flag:1", null],
        ["flag:2", projectB],
        ["flag:3", projectB],
        [`routing:b:${iso(20)}`, projectB],
        ["request:request-a", projectA],
      ],
    );
  });
});

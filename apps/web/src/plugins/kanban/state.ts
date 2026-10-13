import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  HOST_METHODS,
  KANBAN_METHODS,
  KANBAN_WS_METHODS,
  type EnvironmentId,
  type KanbanDecision,
  type KanbanIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";
import { environmentThreadShells } from "~/state/threads";

/** Live board: a snapshot on subscribe, a fresh one after every change on disk or in the app. */
export const kanbanBoard = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:board",
  tag: KANBAN_WS_METHODS.subscribe,
});

/** One issue with its body and log; re-read whenever the board changes. */
export const kanbanIssue = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:issue",
  method: KANBAN_METHODS.getIssue,
  refreshTrigger: ({ environmentId, input }) =>
    kanbanBoard({ environmentId, input: { projectId: input.projectId } }),
});

export const kanbanDecisions = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:decisions",
  method: KANBAN_METHODS.listDecisions,
  refreshTrigger: ({ environmentId, input }) =>
    kanbanBoard({ environmentId, input: { projectId: input.projectId } }),
});

export const kanbanWrite = createPluginRpcCommand(connectionAtomRuntime, {
  label: "kanban:write",
  method: KANBAN_METHODS.write,
});

export const kanbanSetDirectory = createPluginRpcCommand(connectionAtomRuntime, {
  label: "kanban:set-directory",
  method: KANBAN_METHODS.setDirectory,
});

/**
 * The emergency stop: null while it is clear. Nothing pushes a change, so while the board is open
 * it re-reads every 30 seconds to show a stop set or cleared through MCP or another client; a
 * later visit re-reads once the answer is 5 seconds old, and a clear from the banner at once.
 */
export const kanbanStop = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:stop",
  method: KANBAN_METHODS.stopGet,
  staleTimeMs: 5_000,
  refreshIntervalMs: 30_000,
});

export const kanbanStopClear = createPluginRpcCommand(connectionAtomRuntime, {
  label: "kanban:stop-clear",
  method: KANBAN_METHODS.stopClear,
});

/** Changes when a thread's pending request starts or ends, or it settles or leaves the project. */
const pendingRequestsKey = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
  threads
    .map(
      (thread) =>
        `${thread.id} ${thread.source.pendingRuntimeRequest?.id ?? "-"} ${thread.settledOverride ?? "-"} ${thread.settledAt ?? "-"}`,
    )
    .join("\n");

/**
 * What the attention strip refetches on: the window coming back into view, a change in the
 * project's pending requests, and every board snapshot, which follows each board command. Any
 * other shell update, such as streaming text, leaves it equal and refetches nothing.
 */
const attentionSignal = (environmentId: EnvironmentId, projectId: ProjectId) => {
  const threads = environmentThreadShells.threadShellsForProjectRefsAtom([
    { environmentId, projectId },
  ]);
  const board = kanbanBoard({ environmentId, input: { projectId } });
  return Atom.withEquality(
    Atom.make(
      (get) => [get(Atom.windowFocusSignal), pendingRequestsKey(get(threads)), get(board)] as const,
    ),
    (left, right) => left.every((value, index) => Object.is(value, right[index])),
  );
};

/**
 * What waits on a person in a project, for the strip above the board. It re-reads only on the
 * signal above and never polls, so a flag a sweep raises shows on the next of those.
 */
export const kanbanAttention = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:attention",
  method: KANBAN_METHODS.attentionList,
  staleTimeMs: 5_000,
  refreshTrigger: ({ environmentId, input }) => attentionSignal(environmentId, input.projectId),
});

const pluginStatuses = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:plugins",
  method: HOST_METHODS.list,
  staleTimeMs: 60_000,
});

/** Whether `environmentId` runs the kanban plugin; null while unknown. A server without the
    plugin RPCs (upstream T3 Code) fails the call, which counts as off. */
export const kanbanActiveAtom = Atom.family(
  (environmentId: Parameters<typeof pluginStatuses>[0]["environmentId"]) =>
    Atom.make((get) => {
      const result = get(pluginStatuses({ environmentId, input: {} }));
      if (result._tag === "Failure") return false;
      return Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (statuses) => statuses.some((status) => status.id === "kanban" && status.active),
      });
    }),
);

/** Any connected environment runs the plugin, so the Board entry points show. */
export const kanbanSupportedAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).some(
    (environmentId) => get(kanbanActiveAtom(environmentId)) === true,
  ),
);

/** What a new thread sees first: the ticket, then where the rest lives. Decision bodies stay out. */
export function buildIssuePrompt(
  issue: KanbanIssue,
  decisions: ReadonlyArray<KanbanDecision>,
  categories: ReadonlyArray<{ readonly category: string; readonly count: number }>,
): string {
  const byCategory = new Map<string, { for: number; against: number }>();
  for (const decision of decisions) {
    const counts = byCategory.get(decision.category) ?? { for: 0, against: 0 };
    counts[decision.stance] += 1;
    byCategory.set(decision.category, counts);
  }
  const onTicket =
    decisions.length === 0
      ? "Decisions on this ticket: none."
      : `Decisions on this ticket (${decisions.length}): ${[...byCategory]
          .map(([category, counts]) => `${category}: for ${counts.for}, against ${counts.against}`)
          .join("; ")}`;
  const all =
    categories.length === 0
      ? "Decision categories: none yet."
      : `Decision categories: ${categories.map((c) => `${c.category} (${c.count})`).join(", ")}`;
  return [
    issue.title,
    issue.description,
    issue.criteria.length === 0
      ? ""
      : [
          "Acceptance criteria (done means every box is checked):",
          ...issue.criteria.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`),
        ].join("\n"),
    `Issue \`${issue.id}\` on the T3 kanban board.`,
    onTicket,
    all,
    `Read with kanban_list kind=decision issue=${issue.id}, or category=<name>. Report with kanban_write: issue.note for findings, issue.block when you need the user, decision.create for calls you make.`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

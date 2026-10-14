import {
  createKanbanActiveAtomFamily,
  createKanbanAttentionAtomFamily,
  createKanbanBoardAtomFamily,
} from "@t3tools/client-runtime/plugins/kanban";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  KANBAN_METHODS,
  type EnvironmentId,
  type KanbanAttentionRow,
  type KanbanDecision,
  type KanbanIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";

export const kanbanBoard = createKanbanBoardAtomFamily(connectionAtomRuntime);

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

export const kanbanFindingReview = createPluginRpcCommand(connectionAtomRuntime, {
  label: "kanban:finding-review",
  method: KANBAN_METHODS.findingReview,
});

export const kanbanFindingMove = createPluginRpcCommand(connectionAtomRuntime, {
  label: "kanban:finding-move",
  method: KANBAN_METHODS.findingMove,
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

/**
 * What waits on a person in a project, for the strip above the board. It re-reads only on the
 * window coming back into view, a change in the project's pending requests and every board
 * snapshot, and never polls, so a flag a sweep raises shows on the next of those.
 */
export const kanbanAttention = createKanbanAttentionAtomFamily(connectionAtomRuntime, {
  board: kanbanBoard,
  threadShells: environmentThreadShells.threadShellsForProjectRefsAtom,
  focus: Atom.windowFocusSignal,
});

/**
 * Where a strip row's button leads, always on the board's environment: the row's thread, the
 * board, that environment's Plugins page, where budgets and other plugin settings live, or a
 * plugin's screen on the tab and record the flag names. Null when a thread row has no thread.
 */
export function attentionResumeTarget(
  row: Pick<KanbanAttentionRow, "resumeAction" | "threadId">,
  board: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
) {
  switch (row.resumeAction.target) {
    case "thread":
      return row.threadId === null
        ? null
        : ({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(board.environmentId, row.threadId)),
          } as const);
    case "board":
      return { to: "/board", search: board } as const;
    case "settings":
      return { to: "/plugins", search: { machine: board.environmentId } } as const;
    case "plugin": {
      const { pluginId, tab, recordId } = row.resumeAction;
      return {
        to: "/plugins/$pluginId",
        params: { pluginId },
        search: {
          machine: board.environmentId,
          ...(tab === undefined ? {} : { tab }),
          ...(recordId === undefined ? {} : { recordId }),
        },
      } as const;
    }
  }
}

export const kanbanActiveAtom = createKanbanActiveAtomFamily(connectionAtomRuntime);

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

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
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { BoardSearch } from "./BoardPage";

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

/** Changes when the thread's latest run starts or ends, or the window comes back into view. */
const threadRunSignal = (environmentId: EnvironmentId, threadId: ThreadId) => {
  const shell = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return Atom.make((get) => {
    const run = get(shell)?.latestRun;
    return `${get(Atom.windowFocusSignal)} ${run?.runId ?? "-"} ${run?.status ?? "-"}`;
  });
};

/**
 * The decisions linked to one thread (`input.thread`), for the count in its header. It opens no
 * board subscription, so every thread view stays cheap: it re-reads when the thread's latest run
 * starts or ends, which is when an agent's decisions land, and on window focus. A project without
 * a board answers none, and the read creates no folder for it.
 */
export const kanbanThreadDecisions = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:thread-decisions",
  method: KANBAN_METHODS.listDecisions,
  staleTimeMs: 5_000,
  refreshTrigger: ({ environmentId, input }) =>
    input.thread === undefined ? undefined : threadRunSignal(environmentId, input.thread),
});

/**
 * Where "Find decision" in the command palette leads: the decisions view of the thread's project,
 * or of the project the board already shows (`previous` is the current location's search), or
 * else of the board's own pick.
 */
export function findDecisionSearch(
  previous: object,
  thread:
    | { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }
    | null
    | undefined,
): BoardSearch {
  const shown =
    "environmentId" in previous &&
    "projectId" in previous &&
    typeof previous.environmentId === "string" &&
    typeof previous.projectId === "string"
      ? {
          environmentId: previous.environmentId as EnvironmentId,
          projectId: previous.projectId as ProjectId,
        }
      : null;
  const project = thread ?? shown;
  return {
    view: "decisions",
    ...(project === null
      ? {}
      : { environmentId: project.environmentId, projectId: project.projectId }),
  };
}

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
 * board (its decisions view for a decision conflict), that environment's Plugins page, where
 * budgets and other plugin settings live, or a plugin's screen on the tab and record the flag
 * names. Null when a thread row has no thread.
 */
export function attentionResumeTarget(
  row: Pick<KanbanAttentionRow, "resumeAction" | "threadId" | "kind">,
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
      return row.kind === "decision_conflict"
        ? ({ to: "/board", search: { ...board, view: "decisions" } } as const)
        : ({ to: "/board", search: board } as const);
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
  // Per category, how many decisions are in each state, in the order the states first appear.
  const byCategory = new Map<string, Map<KanbanDecision["state"], number>>();
  for (const decision of decisions) {
    const counts = byCategory.get(decision.category) ?? new Map<KanbanDecision["state"], number>();
    counts.set(decision.state, (counts.get(decision.state) ?? 0) + 1);
    byCategory.set(decision.category, counts);
  }
  const onTicket =
    decisions.length === 0
      ? "Decisions on this ticket: none."
      : `Decisions on this ticket (${decisions.length}): ${[...byCategory]
          .map(
            ([category, counts]) =>
              `${category}: ${[...counts].map(([state, count]) => `${state} ${count}`).join(", ")}`,
          )
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

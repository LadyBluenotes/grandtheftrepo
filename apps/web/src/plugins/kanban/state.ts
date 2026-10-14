import {
  createKanbanActiveAtomFamily,
  createKanbanBoardAtomFamily,
  createKanbanProjectsAttentionAtomFamily,
  type KanbanAttentionStripRow,
} from "@t3tools/client-runtime/plugins/kanban";
import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  parseProjectRefCollectionKey,
  projectRefCollectionKey,
} from "@t3tools/client-runtime/state/entities";
import {
  KANBAN_METHODS,
  KanbanDecisionRef,
  type EnvironmentId,
  type KanbanAttentionRow,
  type KanbanBoard,
  type KanbanDecision,
  type KanbanIssue,
  type KanbanProjectAttentionRow,
  type ProjectId,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";
import { formatEnvironmentQueryError } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { BoardSearch } from "./BoardPage";
import { projectIdsByEnvironment, type BoardEnvironment } from "./boardScope";

export const kanbanBoard = createKanbanBoardAtomFamily(connectionAtomRuntime);

const isDecisionRef = Schema.is(KanbanDecisionRef);

/**
 * What a `/board` URL names: the project, the open issue, the decisions view with its category
 * and the decision open in its drawer (`category/id`), and the board's filters. Anything else is
 * dropped.
 */
export function validateBoardSearch(raw: Record<string, unknown>): BoardSearch {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.issue === "string" && raw.issue ? { issue: raw.issue.slice(0, 80) } : {}),
    ...(raw.view === "decisions" ? { view: raw.view } : {}),
    ...(typeof raw.category === "string" && raw.category
      ? { category: raw.category.slice(0, 80) }
      : {}),
    ...(isDecisionRef(raw.decision) ? { decision: raw.decision } : {}),
    ...(raw.needsYou === true ? { needsYou: true } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
  };
}

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
 * Where a strip row's button leads, always on the row's environment: the row's thread, the
 * board (its decisions view for a decision conflict) on the row's project, or on no project for a
 * row about every project, that environment's Plugins page, where budgets and other plugin
 * settings live, or a plugin's screen on the row's project, if it has one, and the tab and record
 * the flag names. Null when a thread row has no thread.
 */
export function attentionResumeTarget(
  row: Pick<KanbanAttentionRow, "resumeAction" | "threadId" | "kind">,
  board: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId | null },
) {
  switch (row.resumeAction.target) {
    case "thread":
      return row.threadId === null
        ? null
        : ({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(board.environmentId, row.threadId)),
          } as const);
    case "board": {
      const project =
        board.projectId === null
          ? {}
          : { environmentId: board.environmentId, projectId: board.projectId };
      return row.kind === "decision_conflict"
        ? ({ to: "/board", search: { ...project, view: "decisions" } } as const)
        : ({ to: "/board", search: project } as const);
    }
    case "settings":
      return { to: "/plugins", search: { machine: board.environmentId } } as const;
    case "plugin": {
      const { pluginId, tab, recordId } = row.resumeAction;
      return {
        to: "/plugins/$pluginId",
        params: { pluginId },
        search: {
          machine: board.environmentId,
          ...(board.projectId === null ? {} : { projectId: board.projectId }),
          ...(tab === undefined ? {} : { tab }),
          ...(recordId === undefined ? {} : { recordId }),
        },
      } as const;
    }
  }
}

export const kanbanActiveAtom = createKanbanActiveAtomFamily(connectionAtomRuntime);

/**
 * Bumped after a write that may have started a board or moved one (a project's first card, or a
 * new folder), so `kanbanBoardEnvironments` reads the projects' board folders again.
 */
export const kanbanBoardsChanged = Atom.make(0).pipe(Atom.keepAlive);

const boardsSignal = Atom.make((get) => [get(Atom.windowFocusSignal), get(kanbanBoardsChanged)]);

/**
 * The board folders of some projects of one environment, and which have a board. Creates nothing.
 * Nothing pushes a new board or folder, so it re-reads when the window comes back into view and
 * after `kanbanBoardsChanged`.
 */
const kanbanBoardFolders = createPluginRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kanban:boards",
  method: KANBAN_METHODS.boards,
  refreshTrigger: () => boardsSignal,
});

const failureMessage = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;

const kanbanBoardEnvironmentsFamily = Atom.family((key: string) => {
  const environments = projectIdsByEnvironment(parseProjectRefCollectionKey(key));
  return Atom.make((get): ReadonlyArray<BoardEnvironment> =>
    environments.map(([environmentId, projectIds]) => {
      const active = get(kanbanActiveAtom(environmentId));
      if (active !== true) return { environmentId, active, folders: null, error: null };
      const result = get(kanbanBoardFolders({ environmentId, input: { projectIds } }));
      return {
        environmentId,
        active,
        folders: Option.getOrNull(AsyncResult.value(result)),
        error: failureMessage(result),
      };
    }),
  ).pipe(Atom.withLabel(`kanban:board-environments:${key}`));
});

/** Per environment of `refs`: whether it runs kanban and, once known, its projects' board folders. */
export const kanbanBoardEnvironments = (refs: ReadonlyArray<ScopedProjectRef>) =>
  kanbanBoardEnvironmentsFamily(projectRefCollectionKey(refs));

interface LoadedBoard extends ScopedProjectRef {
  readonly board: KanbanBoard | null;
  readonly error: string | null;
}

const kanbanBoardsFamily = Atom.family((key: string) => {
  const refs = parseProjectRefCollectionKey(key);
  return Atom.make((get): ReadonlyArray<LoadedBoard> =>
    refs.map((ref) => {
      const result = get(
        kanbanBoard({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
      );
      return {
        ...ref,
        board: Option.getOrNull(AsyncResult.value(result)),
        error: failureMessage(result),
      };
    }),
  ).pipe(Atom.withLabel(`kanban:boards:${key}`));
});

/**
 * One live board per ref, each its own subscription, so a change re-sends only its project's
 * board. Pass only projects that have one: subscribing loads a board, which creates its folder.
 */
export const kanbanBoards = (refs: ReadonlyArray<ScopedProjectRef>) =>
  kanbanBoardsFamily(projectRefCollectionKey(refs));

/**
 * Changes with each snapshot of the boards, among one environment's `projectIds`, that have one.
 * It subscribes to those only: subscribing to a board loads it, which creates its folder.
 */
const subscribedBoardsSignal = Atom.family((key: string) => {
  const refs = parseProjectRefCollectionKey(key);
  const projectIds = refs.map((ref) => ref.projectId);
  return Atom.withEquality(
    Atom.make((get) => {
      const environmentId = refs[0]?.environmentId;
      if (environmentId === undefined) return [];
      // The same read `kanbanBoardEnvironments` makes for these projects, so no second request.
      const folders = Option.getOrNull(
        AsyncResult.value(get(kanbanBoardFolders({ environmentId, input: { projectIds } }))),
      );
      return (folders ?? [])
        .filter((folder) => folder.board)
        .map((folder) =>
          get(kanbanBoard({ environmentId, input: { projectId: folder.projectId } })),
        );
    }),
    (left, right) =>
      left.length === right.length && left.every((value, index) => Object.is(value, right[index])),
  );
});

/**
 * What waits on a person in some projects of one environment, for the strip above the board,
 * whether or not each has a board. It re-reads only on the window coming back into view, a change
 * in the projects' pending requests and every snapshot of their boards, and never polls, so a flag
 * a sweep raises shows on the next of those.
 */
const kanbanProjectsAttention = createKanbanProjectsAttentionAtomFamily(connectionAtomRuntime, {
  boards: ({ environmentId, input }) =>
    subscribedBoardsSignal(
      projectRefCollectionKey(input.projectIds.map((projectId) => ({ environmentId, projectId }))),
    ),
  threadShells: environmentThreadShells.threadShellsForProjectRefsAtom,
  focus: Atom.windowFocusSignal,
});

// Every `since` is an ISO instant, so instants sort as strings.
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** A strip row with the environment it was read from. */
export type BoardAttentionRow = KanbanProjectAttentionRow & {
  readonly environmentId: EnvironmentId;
};

const kanbanBoardAttentionFamily = Atom.family((key: string) => {
  const environments = projectIdsByEnvironment(parseProjectRefCollectionKey(key));
  return Atom.make((get): ReadonlyArray<BoardAttentionRow> =>
    environments
      .flatMap(([environmentId, projectIds]) =>
        (
          Option.getOrNull(
            AsyncResult.value(
              get(kanbanProjectsAttention({ environmentId, input: { projectIds } })),
            ),
          ) ?? []
        ).map((row) => ({ ...row, environmentId })),
      )
      // Each environment's rows are oldest first already; merging keeps that across them.
      .toSorted((left, right) => order(left.since, right.since) || order(left.id, right.id)),
  ).pipe(Atom.withLabel(`kanban:board-attention:${key}`));
});

/**
 * A strip row's title on the board: its thread's (the shared formatter names an untitled one),
 * else the project it is about, or every project for a policy of the whole environment.
 */
export function boardAttentionTitle(
  row: KanbanAttentionStripRow<BoardAttentionRow>,
  projectLabel: (ref: ScopedProjectRef) => string | undefined,
): string {
  if (row.threadId !== null) return row.title;
  if (row.projectId === null) return "Every project";
  return projectLabel({ environmentId: row.environmentId, projectId: row.projectId }) ?? row.title;
}

/**
 * What waits on a person in `refs`, with or without a board: one read per environment, oldest
 * first. Only the projects that have a board are subscribed to, to re-read on their snapshots.
 */
export const kanbanBoardAttention = (refs: ReadonlyArray<ScopedProjectRef>) =>
  kanbanBoardAttentionFamily(projectRefCollectionKey(refs));

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

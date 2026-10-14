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
  type EnvironmentId,
  type KanbanAttentionRow,
  type KanbanBoard,
  type KanbanDecision,
  type KanbanIssue,
  type KanbanProjectAttentionRow,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";
import { formatEnvironmentQueryError } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { BoardEnvironment } from "./boardScope";

const kanbanBoard = createKanbanBoardAtomFamily(connectionAtomRuntime);

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

/**
 * What waits on a person in some projects of one environment, for the strip above the board. It
 * re-reads only on the window coming back into view, a change in the projects' pending requests
 * and every board snapshot, and never polls, so a flag a sweep raises shows on the next of those.
 */
const kanbanProjectsAttention = createKanbanProjectsAttentionAtomFamily(connectionAtomRuntime, {
  board: kanbanBoard,
  threadShells: environmentThreadShells.threadShellsForProjectRefsAtom,
  focus: Atom.windowFocusSignal,
});

/**
 * Where a strip row's button leads, always on the row's environment: the row's thread, the
 * board, or that environment's Plugins page, where budgets and other plugin settings live. Null
 * when a thread row has no thread.
 */
export function attentionResumeTarget(
  row: Pick<KanbanAttentionRow, "resumeAction" | "threadId">,
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
    case "board":
      return {
        to: "/board",
        search:
          board.projectId === null
            ? {}
            : { environmentId: board.environmentId, projectId: board.projectId },
      } as const;
    case "settings":
      return { to: "/plugins", search: { machine: board.environmentId } } as const;
  }
}

const kanbanActiveAtom = createKanbanActiveAtomFamily(connectionAtomRuntime);

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

/** Project ids per environment, sorted, so the same projects make the same read in any order. */
const byEnvironment = (refs: ReadonlyArray<ScopedProjectRef>) => {
  const grouped = new Map<EnvironmentId, Array<ProjectId>>();
  for (const ref of refs)
    grouped.set(ref.environmentId, [...(grouped.get(ref.environmentId) ?? []), ref.projectId]);
  return [...grouped].map(
    ([environmentId, projectIds]) => [environmentId, projectIds.toSorted()] as const,
  );
};

const kanbanBoardEnvironmentsFamily = Atom.family((key: string) => {
  const environments = byEnvironment(parseProjectRefCollectionKey(key));
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

// Every `since` is an ISO instant, so instants sort as strings.
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** A strip row with the environment it was read from. */
export type BoardAttentionRow = KanbanProjectAttentionRow & {
  readonly environmentId: EnvironmentId;
};

const kanbanBoardAttentionFamily = Atom.family((key: string) => {
  const environments = byEnvironment(parseProjectRefCollectionKey(key));
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

/** What waits on a person in the boards of `refs`: one read per environment, oldest first. */
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

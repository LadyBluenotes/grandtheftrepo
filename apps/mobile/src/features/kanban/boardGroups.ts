import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  KANBAN_STATUSES,
  type KanbanBoard,
  type KanbanIssueSummary,
  type KanbanStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

const BOARD_UNAVAILABLE_MESSAGE = "This server does not have the board.";
const BOARD_EMPTY_MESSAGE = "No tickets in this project.";

/** The web board's column names, in `KANBAN_STATUSES` order. */
const STATUS_LABEL: Record<KanbanStatus, string> = {
  triage: "Triage",
  inbox: "Inbox",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** What a ticket's thread adds to its row. */
export interface BoardThread {
  /** When the snooze ends; null unless the thread is snoozed at the time asked. */
  readonly snoozedUntil: string | null;
  readonly pullRequestNumber: number | null;
}

export function boardThread(shell: EnvironmentThreadShell, now: string): BoardThread {
  return {
    snoozedUntil: effectiveSnoozed(shell, { now }) ? (shell.snoozedUntil ?? null) : null,
    pullRequestNumber:
      resolveThreadCurrentPullRequestLink(shell.pullRequests ?? [])?.number ?? null,
  };
}

export interface BoardRow {
  readonly id: string;
  readonly title: string;
  /**
   * What the row says under the title, in order: "Needs you" when an agent blocked the ticket,
   * "2 of 5 open" criteria, the thread's pull request as "#42", and "Snoozed".
   */
  readonly labels: ReadonlyArray<string>;
  /** The thread a tap opens; null when the ticket has none this client knows. */
  readonly threadId: ThreadId | null;
  /** When the "Snoozed" label should go, so the screen can redraw then; null when not snoozed. */
  readonly wakesAt: string | null;
}

interface BoardGroup {
  readonly status: KanbanStatus;
  readonly label: string;
  readonly rows: ReadonlyArray<BoardRow>;
}

export type BoardState =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string }
  | {
      readonly kind: "groups";
      readonly groups: ReadonlyArray<BoardGroup>;
      /** The earliest moment a "Snoozed" label ends. A snooze expiring emits no event. */
      readonly nextWakeAt: string | null;
    };

/** The Board entry shows only where the plugin runs; unknown counts as not yet. */
export function boardEntryVisible(active: boolean | null): boolean {
  return active === true;
}

// Priority, then age: the order the web board keeps inside a column.
const byPriorityThenAge = (a: KanbanIssueSummary, b: KanbanIssueSummary) =>
  a.priority.localeCompare(b.priority) || a.createdAt.localeCompare(b.createdAt);

/** The most recently linked thread this client has, which a tap opens and the row describes. */
function currentThread(
  issue: KanbanIssueSummary,
  threadOf: (id: ThreadId) => BoardThread | undefined,
) {
  let current: {
    readonly id: ThreadId;
    readonly linkedAt: string;
    readonly info: BoardThread;
  } | null = null;
  for (const link of issue.threads) {
    const info = threadOf(link.id);
    if (info !== undefined && (current === null || link.linkedAt > current.linkedAt)) {
      current = { id: link.id, linkedAt: link.linkedAt, info };
    }
  }
  return current;
}

function boardRow(
  issue: KanbanIssueSummary,
  threadOf: (id: ThreadId) => BoardThread | undefined,
): BoardRow {
  const thread = currentThread(issue, threadOf);
  const pullRequestNumber = thread?.info.pullRequestNumber ?? null;
  return {
    id: issue.id,
    title: issue.title,
    labels: [
      ...(issue.blocked === null ? [] : ["Needs you"]),
      ...(issue.criteriaTotal === 0
        ? []
        : [`${issue.criteriaOpen} of ${issue.criteriaTotal} open`]),
      ...(pullRequestNumber === null ? [] : [`#${pullRequestNumber}`]),
      ...(thread?.info.snoozedUntil == null ? [] : ["Snoozed"]),
    ],
    threadId: thread?.id ?? null,
    wakesAt: thread?.info.snoozedUntil ?? null,
  };
}

/**
 * One group per column, in the order the board keeps, with empty groups dropped. Archived
 * tickets stay hidden; the web board shows them only on request.
 */
export function boardGroups(
  board: KanbanBoard,
  threadOf: (id: ThreadId) => BoardThread | undefined,
): ReadonlyArray<BoardGroup> {
  const issues = board.issues.filter((issue) => issue.archivedAt === null);
  return KANBAN_STATUSES.flatMap((status) => {
    const rows = issues
      .filter((issue) => issue.status === status)
      .sort(byPriorityThenAge)
      .map((issue) => boardRow(issue, threadOf));
    return rows.length === 0 ? [] : [{ status, label: STATUS_LABEL[status], rows }];
  });
}

function earliestWake(groups: ReadonlyArray<BoardGroup>): string | null {
  let earliest: string | null = null;
  for (const group of groups) {
    for (const row of group.rows) {
      if (
        row.wakesAt !== null &&
        (earliest === null || Date.parse(row.wakesAt) < Date.parse(earliest))
      ) {
        earliest = row.wakesAt;
      }
    }
  }
  return earliest;
}

export function boardState(input: {
  /** From `plugins.list`; null while it is unknown. */
  readonly active: boolean | null;
  readonly board: KanbanBoard | null;
  readonly error: string | null;
  readonly threadOf: (id: ThreadId) => BoardThread | undefined;
}): BoardState {
  if (input.active === false) {
    return { kind: "unavailable", message: BOARD_UNAVAILABLE_MESSAGE };
  }
  if (input.board !== null) {
    const groups = boardGroups(input.board, input.threadOf);
    return groups.length === 0
      ? { kind: "empty", message: BOARD_EMPTY_MESSAGE }
      : { kind: "groups", groups, nextWakeAt: earliestWake(groups) };
  }
  return input.error === null ? { kind: "loading" } : { kind: "failed", message: input.error };
}

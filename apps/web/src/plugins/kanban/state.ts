import {
  createPluginRpcCommand,
  createPluginRpcQueryAtomFamily,
} from "@t3tools/client-runtime/plugins/rpc";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  HOST_METHODS,
  KANBAN_METHODS,
  KANBAN_WS_METHODS,
  type KanbanDecision,
  type KanbanIssue,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "~/connection/runtime";
import { environmentSummaries } from "~/state/presentation";

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

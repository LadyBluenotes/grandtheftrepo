import {
  HOST_METHODS,
  KANBAN_ATTENTION_KIND_LABELS,
  KANBAN_METHODS,
  KANBAN_WS_METHODS,
  type EnvironmentId,
  type KanbanAttentionRow,
  type ProjectId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "../state/runtime.ts";
import { createPluginRpcQueryAtomFamily } from "./rpc.ts";

/**
 * Live board of one project: a snapshot on subscribe and a fresh one after every change on disk or
 * in the app, so a client that holds it open never needs to poll. Refreshing the atom resubscribes.
 */
export function createKanbanBoardAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:kanban:board",
    tag: KANBAN_WS_METHODS.subscribe,
  });
}

/**
 * Whether `environmentId` runs the kanban plugin; null while unknown. A server without the plugin
 * RPCs (upstream T3 Code) fails the call, which counts as off.
 */
export function createKanbanActiveAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const pluginStatuses = createPluginRpcQueryAtomFamily(runtime, {
    label: "environment-data:plugins",
    method: HOST_METHODS.list,
    staleTimeMs: 60_000,
  });
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): boolean | null => {
      const result = get(pluginStatuses({ environmentId, input: {} }));
      if (result._tag === "Failure") return false;
      return Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (statuses) => statuses.some((status) => status.id === "kanban" && status.active),
      });
    }).pipe(Atom.withLabel(`environment-data:kanban:active:${environmentId}`)),
  );
}

/** Changes when a thread's pending request starts or ends, or it settles or leaves the project. */
const pendingRequestsKey = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
  threads
    .map(
      (thread) =>
        `${thread.id} ${thread.source.pendingRuntimeRequest?.id ?? "-"} ${thread.settledOverride ?? "-"} ${thread.settledAt ?? "-"}`,
    )
    .join("\n");

/**
 * What waits on a person in a project, for the strip above the board: the `kanban.attention.list`
 * rows. It re-reads when `focus` changes, when a project thread's pending request starts or ends
 * or the thread settles, and on every board snapshot, which follows each board command. Any other
 * shell update, such as streaming text, leaves the signal equal and refetches nothing. It never
 * polls, so a flag a sweep raises shows on the next of those.
 *
 * A client passes its own board and thread atoms, and `focus` for whatever brings the strip back
 * into view (the web passes the window's focus signal).
 */
export function createKanbanAttentionAtomFamily<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  sources: {
    readonly board: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    }) => Atom.Atom<unknown>;
    readonly threadShells: (
      refs: ReadonlyArray<ScopedProjectRef>,
    ) => Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
    readonly focus?: Atom.Atom<unknown>;
  },
) {
  const signal = (environmentId: EnvironmentId, projectId: ProjectId) => {
    const threads = sources.threadShells([{ environmentId, projectId }]);
    const board = sources.board({ environmentId, input: { projectId } });
    return Atom.withEquality(
      Atom.make(
        (get) =>
          [
            sources.focus === undefined ? undefined : get(sources.focus),
            pendingRequestsKey(get(threads)),
            get(board),
          ] as const,
      ),
      (left, right) => left.every((value, index) => Object.is(value, right[index])),
    );
  };
  return createPluginRpcQueryAtomFamily(runtime, {
    label: "environment-data:kanban:attention",
    method: KANBAN_METHODS.attentionList,
    staleTimeMs: 5_000,
    refreshTrigger: ({ environmentId, input }) => signal(environmentId, input.projectId),
  });
}

/** A strip row with the words a client shows for it. */
export type KanbanAttentionStripRow = KanbanAttentionRow & {
  /** The kind in words: "Question", "Budget breach". */
  readonly label: string;
  /** The thread's own title, "Untitled thread" when it has none, or "This project" for a flag. */
  readonly title: string;
};

/**
 * The strip's rows in the order the server returned them, oldest first, each with its kind's label
 * and a title. A row with a `threadId` leads to that thread; one without is about the project and
 * leads to no thread.
 */
export function kanbanAttentionStripRows(
  rows: ReadonlyArray<KanbanAttentionRow>,
): ReadonlyArray<KanbanAttentionStripRow> {
  return rows.map((row) => ({
    ...row,
    label: KANBAN_ATTENTION_KIND_LABELS[row.kind],
    title: row.threadTitle === null ? "This project" : row.threadTitle.trim() || "Untitled thread",
  }));
}

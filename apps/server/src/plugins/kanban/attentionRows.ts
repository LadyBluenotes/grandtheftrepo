import type {
  KanbanAttentionRow,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ThreadShell,
  ProjectId,
  RoutingMismatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as Attention from "../Attention.ts";

const OPEN_THREAD = { label: "Open thread", target: "thread" } as const;

/**
 * How each pending request kind shows. A dynamic tool call and an auth refresh wait on the
 * provider, not on a person, so they show nothing.
 */
const REQUESTS: Record<
  OrchestrationV2PendingRuntimeRequestSummary["kind"],
  { readonly kind: "question" | "permission"; readonly text: string } | null
> = {
  user_input: { kind: "question", text: "The agent asked you a question." },
  "mcp-elicitation": { kind: "question", text: "An MCP server is asking you for input." },
  command: { kind: "permission", text: "The agent wants to run a command." },
  "file-read": { kind: "permission", text: "The agent wants to read a file." },
  "file-change": { kind: "permission", text: "The agent wants to change files." },
  permission: { kind: "permission", text: "The agent is asking for a permission." },
  dynamic_tool_call: null,
  auth_refresh: null,
};

const isSettled = (thread: OrchestrationV2ThreadShell) =>
  thread.settledOverride === "settled" || thread.settledAt !== null;

/**
 * One project's attention rows, oldest first, from three sources:
 *
 * - the pending request on each of the project's threads that is neither archived nor settled;
 * - open flags on one of its unarchived threads, or keyed to the project itself: a key that ends in
 *   `:<projectId>`, such as a budget's `budget:<id>:<projectId>`, or has it as a segment, such as a
 *   delivery drift flag's `policy:<projectId>:<agent>:<path>`; a flag on another project's thread,
 *   or on an archived one, is left out;
 * - routing mismatches on one of its unarchived threads.
 */
export const attentionRows = (input: {
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly flags: ReadonlyArray<Attention.OpenFlag>;
  readonly mismatches: ReadonlyArray<RoutingMismatch>;
}): ReadonlyArray<KanbanAttentionRow> => {
  const active = input.threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null,
  );
  const byId = new Map<string, OrchestrationV2ThreadShell>(
    active.map((thread) => [thread.id, thread]),
  );

  const requests = active.flatMap((thread): ReadonlyArray<KanbanAttentionRow> => {
    const request = thread.pendingRuntimeRequest;
    const shown = request === null || isSettled(thread) ? null : REQUESTS[request.kind];
    return request === null || shown === null
      ? []
      : [
          {
            source: "request",
            id: `request:${request.id}`,
            threadId: thread.id,
            threadTitle: thread.title,
            kind: shown.kind,
            text: shown.text,
            resumeAction: OPEN_THREAD,
            since: DateTime.formatIso(request.createdAt),
          },
        ];
  });

  const flags = input.flags.flatMap((flag): ReadonlyArray<KanbanAttentionRow> => {
    const thread = byId.get(flag.threadId);
    const projectKey =
      flag.threadId.endsWith(`:${input.projectId}`) ||
      flag.threadId.includes(`:${input.projectId}:`);
    if (thread === undefined && !projectKey) return [];
    return [
      {
        source: "flag",
        id: `flag:${flag.id}`,
        threadId: thread?.id ?? null,
        threadTitle: thread?.title ?? null,
        kind: flag.kind,
        text: flag.text,
        resumeAction: flag.resumeAction,
        since: flag.raisedAt,
      },
    ];
  });

  const mismatches = input.mismatches.flatMap((mismatch): ReadonlyArray<KanbanAttentionRow> => {
    const thread = byId.get(mismatch.threadId);
    return thread === undefined
      ? []
      : [
          {
            source: "flag",
            id: `routing:${mismatch.threadId}:${mismatch.at}`,
            threadId: thread.id,
            threadTitle: thread.title,
            kind: "routing_mismatch",
            text: mismatch.flag,
            resumeAction: OPEN_THREAD,
            since: mismatch.at,
          },
        ];
  });

  // Every `since` comes from `DateTime.formatIso`, so instants sort as strings.
  const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...requests, ...flags, ...mismatches].toSorted(
    (left, right) => order(left.since, right.since) || order(left.id, right.id),
  );
};

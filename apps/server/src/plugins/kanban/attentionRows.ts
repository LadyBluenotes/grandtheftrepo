import type {
  KanbanAttentionRow,
  KanbanProjectAttentionRow,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ThreadShell,
  ProjectId,
  RoutingMismatch,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as Attention from "../Attention.ts";
import { flagKeyedToEveryProject, flagKeyedToProject } from "../attentionKeys.ts";

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

const flagRowId = (flag: Attention.OpenFlag) => `flag:${flag.id}`;

// Every `since` comes from `DateTime.formatIso`, so instants sort as strings.
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const oldestFirst = (left: KanbanAttentionRow, right: KanbanAttentionRow) =>
  order(left.since, right.since) || order(left.id, right.id);

interface ProjectSources {
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly mismatches: ReadonlyArray<RoutingMismatch>;
}

/**
 * One project's attention rows, oldest first, from three sources:
 *
 * - the pending request on each of the project's threads that is neither archived nor settled;
 * - open flags on one of its unarchived threads, or keyed to the project itself (see
 *   `flagKeyedToProject`, which includes a `policy:*:` key, a policy of the whole environment that
 *   every project's board lists); a flag on another project's thread, or on an archived one, is
 *   left out;
 * - routing mismatches on one of its unarchived threads.
 */
export const attentionRows = (
  input: ProjectSources & { readonly flags: ReadonlyArray<Attention.OpenFlag> },
): ReadonlyArray<KanbanAttentionRow> => {
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
    if (thread === undefined && !flagKeyedToProject(flag.threadId, input.projectId)) return [];
    return [
      {
        source: "flag",
        id: flagRowId(flag),
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

  return [...requests, ...flags, ...mismatches].toSorted(oldestFirst);
};

/**
 * Several projects' rows, oldest first, each with its project. A `policy:*` flag matches every
 * project, so it is listed once, with no project.
 */
export const projectsAttentionRows = (input: {
  readonly projects: ReadonlyArray<ProjectSources>;
  readonly flags: ReadonlyArray<Attention.OpenFlag>;
}): ReadonlyArray<KanbanProjectAttentionRow> => {
  const everyProject = new Set(
    input.flags.filter((flag) => flagKeyedToEveryProject(flag.threadId)).map(flagRowId),
  );
  const rows = new Map<string, KanbanProjectAttentionRow>();
  for (const project of input.projects)
    for (const row of attentionRows({ ...project, flags: input.flags }))
      if (!rows.has(row.id))
        rows.set(row.id, {
          ...row,
          projectId: everyProject.has(row.id) ? null : project.projectId,
        });
  return [...rows.values()].toSorted(oldestFirst);
};

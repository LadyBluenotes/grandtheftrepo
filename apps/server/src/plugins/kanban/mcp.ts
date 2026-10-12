import {
  KANBAN_STATUSES,
  KanbanSlug,
  KanbanStatus,
  KanbanWrite,
  OrchestratorMcpFailure,
  ProjectId,
  type KanbanDecision,
  type KanbanError,
  type KanbanIssue,
  type KanbanIssueSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { formatLogEntry } from "./KanbanFiles.ts";
import * as KanbanStore from "./KanbanStore.ts";

const shared = {
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const KanbanListTool = Tool.make("kanban_list", {
  ...shared,
  description:
    "List the project's kanban issues or decisions, one line each; pass id for one item in full (issue: description, log, related decisions; decision: why). Issue line: id · status · priority · title · labels · verification · BLOCKED · threads. Columns in order: triage (found, verification unverified/partial/verified), inbox (reproduced, waiting for the user), todo, in_progress, in_review, done. Decisions are for/against calls grouped by category; narrow with category or issue.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    kind: Schema.Literals(["issue", "decision"]),
    id: Schema.optional(KanbanSlug),
    status: Schema.optional(KanbanStatus),
    category: Schema.optional(KanbanSlug),
    /** Decisions about this issue. */
    issue: Schema.optional(KanbanSlug),
    includeArchived: Schema.optional(Schema.Boolean),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const KanbanWriteTool = Tool.make("kanban_write", {
  ...shared,
  description:
    "Change the kanban board; returns the id. issue.create files a ticket (status defaults to triage; use inbox once reproduced; set verification, priority p0-p5, labels). Agents cannot move a card out of triage or inbox into todo or beyond, nor link a thread to one: the user releases work. issue.move sets status; issue.note appends to the log; issue.block with reason marks that it needs the user, issue.unblock clears it; issue.link attaches a thread (omit threadId for the calling thread); issue.archive hides it. decision.create records a for/against call under category (default general) with title, why and related issues; decision.update and decision.delete take category and id.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId), ...KanbanWrite.fields }),
}).annotate(Tool.Destructive, true);

export const KanbanToolkit = Toolkit.make(KanbanListTool, KanbanWriteTool);

const failure = (error: KanbanError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const issueLine = (issue: KanbanIssueSummary) =>
  [
    issue.id,
    issue.status,
    issue.priority,
    issue.title,
    issue.labels.length > 0 ? issue.labels.join(",") : null,
    issue.verification === "unverified" ? null : issue.verification,
    issue.blocked === null ? null : `BLOCKED: ${issue.blocked.reason}`,
    issue.threads.length > 0 ? `threads:${issue.threads.length}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const decisionLine = (decision: KanbanDecision) =>
  `${decision.category} · ${decision.stance} · ${decision.id} · ${decision.title}${
    decision.issues.length > 0 ? ` · ${decision.issues.join(",")}` : ""
  }`;

const issueText = (issue: KanbanIssue, decisions: ReadonlyArray<KanbanDecision>) =>
  [
    issueLine(issue),
    `created ${issue.createdAt} by ${issue.createdBy} · updated ${issue.updatedAt}`,
    issue.description.length > 0 ? issue.description : "(no description)",
    ...(issue.log.length > 0 ? ["Log:", ...issue.log.map(formatLogEntry)] : []),
    ...(decisions.length > 0
      ? ["Decisions:", ...decisions.map((d) => `${decisionLine(d)}\n    why: ${d.why}`)]
      : []),
  ].join("\n");

const byBoardOrder = (a: KanbanIssueSummary, b: KanbanIssueSummary) =>
  KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status) ||
  a.priority.localeCompare(b.priority) ||
  a.createdAt.localeCompare(b.createdAt);

/**
 * The store is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the store is there.
 */
export const handlers = McpToolAccess.toLayer(
  KanbanToolkit,
  Effect.map(Effect.serviceOption(KanbanStore.KanbanStore), (storeOption) => {
    const store = Option.match(storeOption, {
      onNone: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The kanban plugin is not active.",
          }),
        ),
      onSome: Effect.succeed,
    });
    return {
      kanban_list: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, input.projectId);
          const kanban = yield* store;
          if (input.kind === "decision") {
            const decisions = yield* kanban.listDecisions({
              projectId,
              ...(input.category === undefined ? {} : { category: input.category }),
              ...(input.issue === undefined ? {} : { issue: input.issue }),
            });
            if (input.id !== undefined) {
              const found = decisions.find((d) => d.id === input.id);
              return found === undefined
                ? `No decision "${input.id}".`
                : `${decisionLine(found)}\nwhy: ${found.why}\nby ${found.by} at ${found.at}`;
            }
            return decisions.length === 0
              ? "No decisions."
              : decisions.map(decisionLine).join("\n");
          }
          if (input.id !== undefined) {
            const issue = yield* kanban.getIssue({ projectId, id: input.id });
            const decisions = yield* kanban.listDecisions({ projectId, issue: input.id });
            return issueText(issue, decisions);
          }
          const board = yield* kanban.board(projectId);
          const shown = board.issues
            .filter(
              (issue) =>
                (input.includeArchived === true || issue.archivedAt === null) &&
                (input.status === undefined || issue.status === input.status),
            )
            .sort(byBoardOrder);
          return [
            `Files: ${board.directory}`,
            ...(shown.length === 0 ? ["No issues."] : shown.map(issueLine)),
          ].join("\n");
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      kanban_write: McpToolAccess.writes(({ projectId: given, ...write }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          const kanban = yield* store;
          const caller = context.caller;
          const actor = caller === undefined ? "agent" : `thread:${caller.id}`;
          const threadId =
            write.threadId ??
            (write.action === "issue.link" || write.action === "issue.unlink"
              ? caller?.id
              : undefined);
          const result = yield* kanban.write(projectId, actor, {
            ...write,
            ...(threadId === undefined ? {} : { threadId }),
          });
          return result.id;
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

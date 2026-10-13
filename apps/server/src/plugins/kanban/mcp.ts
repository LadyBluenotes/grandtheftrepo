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
  type KanbanSpecAttempt,
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
import * as SpecService from "./spec/SpecService.ts";
import * as StopGate from "./StopGate.ts";

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
    "List the project's kanban issues or decisions, one line each; pass id for one item in full (issue: description, acceptance criteria with ids, log, related decisions; decision: why). Issue line: id · status · priority · title · labels · verification · tier · criteria done/total · BLOCKED · threads. Columns in order: triage (found, verification unverified/partial/verified), inbox (reproduced, waiting for the user), todo, in_progress, in_review, done. Decisions are for/against calls grouped by category; narrow with category or issue.",
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
    "Change the kanban board; returns the id. issue.create files a ticket (status defaults to triage; use inbox once reproduced; set verification, priority p0-p5, labels, tier cheap/standard/strong). Agents cannot move a card out of triage or inbox into todo or beyond, nor link a thread to one: the user releases work. issue.move sets status; moving to done is refused while an acceptance criterion is unchecked, and leaving done needs reopenReason defect or scope_change. criterion.add with text defines done; criterion.update takes criterionId with checked and/or text; criterion.remove takes criterionId. issue.note appends to the log; issue.block with reason marks that it needs the user, issue.unblock clears it; issue.link attaches a thread (omit threadId for the calling thread); issue.archive hides it. decision.create records a for/against call under category (default general) with title, why and related issues; decision.update and decision.delete take category and id.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId), ...KanbanWrite.fields }),
}).annotate(Tool.Destructive, true);

const KanbanStopTool = Tool.make("kanban_stop", {
  ...shared,
  description:
    "The emergency stop. action set (with an optional reason) stops everything the supervisor would launch from the board until it is cleared; action clear lifts it. It stops no running agent, and a person starting work by hand is never blocked. Setting it twice or clearing it when it is not set changes nothing. Returns the state.",
  parameters: Schema.Struct({
    action: Schema.Literals(["set", "clear"]),
    reason: Schema.optional(Schema.String),
  }),
})
  .annotate(Tool.Title, "Set or clear the emergency stop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const KanbanTicketSpecifyTool = Tool.make("kanban_ticket_specify", {
  ...shared,
  description:
    "Turn a Triage or Inbox issue into a checkable spec: ## Goal (not empty), ## Approach (a list of two to five items), ## Acceptance (a checklist of - [ ] items, at least one), and optionally ## Out of scope last; no other headings. By default starts one drafting thread in plan mode on the routing plugin's cheap tier and returns the attempt as running; kanban_spec_get shows the result once that thread's run ends. useExisting:true checks the issue's description as written instead, with no thread and no model. A valid spec makes its Acceptance items the issue's criteria and admits it to Todo; a malformed one leaves the issue untouched and gives the reason. The description is never edited. One attempt per call, never retried; an admitted issue is refused, and the emergency stop holds back the drafting thread.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    id: KanbanSlug,
    useExisting: Schema.optional(Schema.Boolean),
  }),
})
  .annotate(Tool.Title, "Draft or check an issue's spec")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const KanbanSpecGetTool = Tool.make("kanban_spec_get", {
  ...shared,
  description:
    "The latest spec attempt for a kanban issue: running, valid or malformed, with the reason a malformed one was refused and the text that was checked. valid means the spec passed, not that the card moved: the result also gives the status the issue is in now.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId), id: KanbanSlug }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const KanbanToolkit = Toolkit.make(
  KanbanListTool,
  KanbanWriteTool,
  KanbanStopTool,
  KanbanTicketSpecifyTool,
  KanbanSpecGetTool,
);

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
    issue.tier,
    issue.criteriaTotal === 0
      ? null
      : `criteria ${issue.criteriaTotal - issue.criteriaOpen}/${issue.criteriaTotal}`,
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
    issueLine({
      ...issue,
      criteriaOpen: issue.criteria.filter((c) => !c.checked).length,
      criteriaTotal: issue.criteria.length,
    }),
    `created ${issue.createdAt} by ${issue.createdBy} · updated ${issue.updatedAt}${
      issue.reopened === null ? "" : ` · reopened (${issue.reopened.reason}) ${issue.reopened.at}`
    }`,
    issue.description.length > 0 ? issue.description : "(no description)",
    ...(issue.criteria.length > 0
      ? [
          "Acceptance criteria:",
          ...issue.criteria.map((c) => `- [${c.checked ? "x" : " "}] ${c.id} ${c.text}`),
        ]
      : []),
    ...(issue.log.length > 0 ? ["Log:", ...issue.log.map(formatLogEntry)] : []),
    ...(decisions.length > 0
      ? ["Decisions:", ...decisions.map((d) => `${decisionLine(d)}\n    why: ${d.why}`)]
      : []),
  ].join("\n");

/** Where the issue is now, after a spec that passed: a passed spec does not say the card moved. */
const placement = (issueStatus: KanbanStatus | null) =>
  issueStatus === null
    ? ", but the issue no longer exists"
    : issueStatus === "triage" || issueStatus === "inbox"
      ? `, but the issue is still in ${issueStatus}, waiting to be admitted: call kanban_ticket_specify again`
      : `; the issue is in ${issueStatus}`;

/** `issueStatus` is where the issue is now, null once it is deleted; omitted when it is not known. */
const attemptText = (attempt: KanbanSpecAttempt, issueStatus?: KanbanStatus | null) => {
  const from =
    attempt.childThreadId === null ? "the description" : `drafting thread ${attempt.childThreadId}`;
  const head = `Spec attempt ${attempt.id} for ${attempt.issueId}, from ${from}: ${attempt.status}.`;
  const text = attempt.text === null ? "" : `\n\n${attempt.text}`;
  switch (attempt.status) {
    case "running":
      return `${head} kanban_spec_get shows the result once the thread's run ends.`;
    case "valid":
      return `${head} The spec passed${issueStatus === undefined ? "" : placement(issueStatus)}.${text}`;
    case "malformed":
      return `${head} ${attempt.reason ?? ""} ${
        issueStatus === null ? "The issue no longer exists." : "The spec did not modify the issue."
      }${text}`;
  }
};

const byBoardOrder = (a: KanbanIssueSummary, b: KanbanIssueSummary) =>
  KANBAN_STATUSES.indexOf(a.status) - KANBAN_STATUSES.indexOf(b.status) ||
  a.priority.localeCompare(b.priority) ||
  a.createdAt.localeCompare(b.createdAt);

const pluginServices = Effect.all([
  Effect.serviceOption(KanbanStore.KanbanStore),
  Effect.serviceOption(StopGate.StopGate),
  Effect.serviceOption(SpecService.SpecService),
]);

/**
 * The store and the stop gate are read when the handlers are built, not declared as tool
 * dependencies: plugin services are typed as absent from the server chain, and these tools only
 * register while the plugin is active, which is when they are there.
 */
export const handlers = McpToolAccess.toLayer(
  KanbanToolkit,
  Effect.map(pluginServices, ([storeOption, gateOption, specOption]) => {
    const inactive = () =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The kanban plugin is not active.",
        }),
      );
    const store = Option.match(storeOption, { onNone: inactive, onSome: Effect.succeed });
    const gate = Option.match(gateOption, { onNone: inactive, onSome: Effect.succeed });
    const spec = Option.match(specOption, { onNone: inactive, onSome: Effect.succeed });
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
      kanban_stop: McpToolAccess.writes(({ action, reason }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const stop = yield* gate;
          if (action === "clear") {
            yield* stop.clear;
            return "Emergency stop is clear.";
          }
          const caller = context.caller;
          const set = yield* stop.set({
            setBy: caller === undefined ? "agent" : `thread:${caller.id}`,
            reason,
          });
          return `Emergency stop is set (since ${set.setAt} by ${set.setBy}${
            set.reason === null ? "" : `: ${set.reason}`
          }).`;
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      // The drafting thread only reads, so it asks for the strictest modes, which no caller is
      // below. `useExisting` starts no thread; it passes the same check, which costs it nothing.
      kanban_ticket_specify: McpToolAccess.startsThreads(
        () => ({ runtimeMode: "approval-required", interactionMode: "plan" }),
        ({ projectId: given, id, useExisting }, modes) =>
          Effect.gen(function* () {
            const projectId = yield* resolveProjectId(yield* readCaller(), given);
            const attempt = yield* (yield* spec).specify({
              projectId,
              id,
              modes,
              ...(useExisting === undefined ? {} : { useExisting }),
            });
            return attemptText(attempt);
          }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      kanban_spec_get: McpToolAccess.reads(({ projectId: given, id }) =>
        Effect.gen(function* () {
          const projectId = yield* resolveProjectId(yield* readCaller(), given);
          const report = yield* (yield* spec).latest({ projectId, id });
          return report === null
            ? `No spec attempt for ${id}.`
            : attemptText(report.attempt, report.issueStatus);
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

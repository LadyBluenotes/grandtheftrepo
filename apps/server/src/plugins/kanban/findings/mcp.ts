import {
  KanbanFindingDisposition,
  KanbanFindingPlacement,
  KanbanFindingScope,
  KanbanFindingTruth,
  KanbanSlug,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { type Caller, readCaller, resolveProjectId } from "../../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { failure } from "../mcp.ts";
import * as FindingService from "./FindingService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const FindingSearchTool = Tool.make("finding_search", {
  ...shared,
  description: `Look for a problem in the project's findings and issues before capturing it, so it is not filed twice. Answers with the matches, one line each, and a searchId that finding_capture from this thread needs: one capture within ${FindingService.SEARCH_WINDOW_MINUTES} minutes. projectId defaults to your thread's project.`,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    query: TrimmedNonEmptyString,
  }),
  success: Schema.String,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FindingCaptureTool = Tool.make("finding_capture", {
  ...shared,
  description:
    "Record a problem you found outside your task: a bug, debt or risk. Pass the searchId of your finding_search. With issueId it is attached to that existing issue; without, a Triage issue labeled finding is opened for it. title is one line; evidence says what you saw and where (files, commands, output); truthStatus seen, partially_verified, reproduced, refuted or unknown; scopeRelation caused_by_current_change, pre_existing, adjacent, unrelated or unknown. It starts open, and someone other than you reviews it. Answers with the finding and the issue holding it.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    title: TrimmedNonEmptyString,
    evidence: TrimmedNonEmptyString,
    truthStatus: KanbanFindingTruth,
    scopeRelation: KanbanFindingScope,
    issueId: Schema.optional(KanbanSlug),
    searchId: TrimmedNonEmptyString,
  }),
  success: KanbanFindingPlacement,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const FindingReviewTool = Tool.make("finding_review", {
  ...shared,
  description:
    "Decide what happens to a finding, with a reason: disposition fix_now, ticketed, accepted_risk, duplicate, rejected, wont_fix, or open to reopen it. Whoever captured it cannot review it. Answers with the finding and the issue holding it.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    id: KanbanSlug,
    disposition: KanbanFindingDisposition,
    reason: TrimmedNonEmptyString,
  }),
  success: KanbanFindingPlacement,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const FindingMoveTool = Tool.make("finding_move", {
  ...shared,
  description:
    "Move a finding attached to the wrong issue to issueId, or, without issueId, to a new Triage issue labeled finding. It keeps its id, disposition and review. Answers with the finding and its new issue.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    id: KanbanSlug,
    issueId: Schema.optional(KanbanSlug),
  }),
  success: KanbanFindingPlacement,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const FindingToolkit = Toolkit.make(
  FindingSearchTool,
  FindingCaptureTool,
  FindingReviewTool,
  FindingMoveTool,
);

/** The calling thread; the declaration already refused a caller outside one. */
const threadCaller = Effect.flatMap(readCaller(), (context) =>
  context.caller === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "Findings are searched and captured from a T3 thread.",
        }),
      )
    : Effect.succeed({ context, caller: context.caller }),
);

/** `thread:<id>` for an agent in a thread, `agent` for a client outside one, as `kanban_write`. */
const actorOf = ({ caller }: Caller) => (caller === undefined ? "agent" : `thread:${caller.id}`);

/** Read when the handlers are built, as the kanban tools read the store. */
export const handlers = McpToolAccess.toLayer(
  FindingToolkit,
  Effect.map(Effect.serviceOption(FindingService.FindingService), (serviceOption) => {
    const service = Option.match(serviceOption, {
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
      finding_search: McpToolAccess.readsAsCaller(({ projectId: given, query }) =>
        Effect.gen(function* () {
          const { context, caller } = yield* threadCaller;
          const projectId = yield* resolveProjectId(context, given);
          const found = yield* (yield* service).search({
            projectId,
            threadId: caller.id,
            query,
          });
          const findings = found.findings.map(
            ({ issue, finding }) =>
              `${finding.id} · ${finding.disposition} · ${finding.truthStatus} · ${finding.title} · on ${issue.id} (${issue.status})`,
          );
          const issues = found.issues.map(
            (issue) => `${issue.id} · ${issue.status} · ${issue.title}`,
          );
          return [
            `searchId: ${found.searchId}`,
            ...(findings.length === 0 ? ["No matching findings."] : ["Findings:", ...findings]),
            ...(issues.length === 0 ? ["No matching issues."] : ["Issues:", ...issues]),
          ].join("\n");
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      finding_capture: McpToolAccess.actsAsCaller(({ projectId: given, ...finding }) =>
        Effect.gen(function* () {
          const { context, caller } = yield* threadCaller;
          const projectId = yield* resolveProjectId(context, given);
          return yield* (yield* service).capture({ ...finding, projectId, threadId: caller.id });
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      finding_review: McpToolAccess.writes(({ projectId: given, ...review }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          return yield* (yield* service).review({ ...review, projectId }, actorOf(context));
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
      finding_move: McpToolAccess.writes(({ projectId: given, ...move }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          return yield* (yield* service).move({ ...move, projectId }, actorOf(context));
        }).pipe(Effect.catchTags({ KanbanError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

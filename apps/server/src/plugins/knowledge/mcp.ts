import {
  KNOWLEDGE_DIRECTORY,
  KnowledgeBody,
  KnowledgeEntry,
  KnowledgeKey,
  KnowledgeTitle,
  knowledgePagePath,
  OrchestratorMcpFailure,
  ProjectId,
  type KnowledgeError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const KnowledgeProposeTool = Tool.make("knowledge_propose", {
  ...shared,
  description: `Propose a knowledge page for the project: one durable fact an agent working in this repository should know, such as a convention, a trap, or where something lives. key names the file ${KNOWLEDGE_DIRECTORY}/<key>.md ([a-z0-9-], unique among the project's pages), title one line, body markdown of at most 4,000 characters. The page is a draft until a person accepts it; nothing is written to the project before then. projectId defaults to your thread's project. Answers with the draft.`,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    key: KnowledgeKey,
    title: KnowledgeTitle,
    body: KnowledgeBody,
  }),
  success: KnowledgeEntry,
})
  .annotate(Tool.Title, "Propose a knowledge page")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const KnowledgeListTool = Tool.make("knowledge_list", {
  ...shared,
  description:
    "List the project's accepted knowledge pages, one line each: the page's path from the project root, then its title. Read the page that matches your task before changing code. projectId defaults to your thread's project.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: Schema.String,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const KnowledgeToolkit = Toolkit.make(KnowledgeProposeTool, KnowledgeListTool);

const failure = (error: KnowledgeError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/**
 * The store is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while the
 * plugin is active, which is when the store is there.
 */
export const handlers = McpToolAccess.toLayer(
  KnowledgeToolkit,
  Effect.map(Effect.serviceOption(KnowledgeStore.KnowledgeStore), (storeOption) => {
    const store = Option.match(storeOption, {
      onNone: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: 'Plugin "knowledge" is not running.',
          }),
        ),
      onSome: Effect.succeed,
    });
    return {
      knowledge_propose: McpToolAccess.actsAsCaller(({ projectId, ...page }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const { caller } = context;
          if (caller === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "thread_credential_required",
              message:
                "A page is proposed from a T3 thread; this MCP client is not running in one.",
            });
          }
          const target = yield* resolveProjectId(context, projectId);
          return yield* (yield* store).propose(
            { projectId: target, ...page },
            { kind: "agent", threadId: caller.id },
          );
        }).pipe(Effect.catchTags({ KnowledgeError: (error) => Effect.fail(failure(error)) })),
      ),
      knowledge_list: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, input.projectId);
          const pages = yield* (yield* store).list({ projectId, state: "accepted" });
          if (pages.length === 0) return "No accepted knowledge pages.";
          return pages.map((page) => `${knowledgePagePath(page.key)}: ${page.title}`).join("\n");
        }).pipe(Effect.catchTags({ KnowledgeError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

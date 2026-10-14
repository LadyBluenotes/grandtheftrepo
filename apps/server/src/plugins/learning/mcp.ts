import {
  LearningCorrection,
  LearningCorrectionInput,
  LearningCorrectionsInput,
  LearningDeclaredMode,
  type LearningError,
  LearningItem,
  LearningItemDetail,
  LearningItemInput,
  LearningItemsInput,
  OrchestratorMcpFailure,
  ProjectId,
  Prompt,
  PromptBody,
  PromptKind,
  PromptSearchResult,
  PromptTitle,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as CorrectionStore from "./CorrectionStore.ts";
import * as ItemStore from "./items/ItemStore.ts";
import * as PromptStore from "./prompts/PromptStore.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const CorrectionsTool = Tool.make("learning_corrections", {
  ...shared,
  description:
    "List a project's corrections, recorded instances of work going wrong, created between two ISO timestamps (inclusive). Omit projectId for the calling thread's project; narrow with failureKind: provider_turn_failed, provider_turn_interrupted, changes_requested, reopened_after_settlement, review_verdict, security or manual.",
  parameters: Schema.Struct({
    ...LearningCorrectionsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(LearningCorrection),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CorrectionTool = Tool.make("learning_correction", {
  ...shared,
  description: "One correction by id, as learning_corrections lists it.",
  parameters: LearningCorrectionInput,
  success: LearningCorrection,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CorrectionAddTool = Tool.make("learning_correction_add", {
  ...shared,
  description:
    "Record a correction by hand: an instance of work being wrong that no server event caught. Omit threadId for the calling thread; the correction takes the thread's project, and a projectId that differs from it is refused. declaredMode names the review failure mode when a reviewer or person named one. Secrets in the description are redacted and it is cut at 500 characters.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    threadId: Schema.optional(ThreadId),
    description: Schema.String,
    declaredMode: Schema.optional(LearningDeclaredMode),
  }),
  success: LearningCorrection,
})
  .annotate(Tool.Title, "Record a correction")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ItemsTool = Tool.make("learning_items", {
  ...shared,
  description:
    "List a project's learning items, one per recurring failure mode, most recently updated first. Each says how often the mode recurred, who should act on it (ownerKind: project_knowledge, prompt, policy or local_only) and whether it is open, candidate, promoted or closed. Omit projectId for the calling thread's project; narrow with state.",
  parameters: Schema.Struct({
    ...LearningItemsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Array(LearningItem),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ItemTool = Tool.make("learning_item", {
  ...shared,
  description:
    "One learning item by id, with its evidence (one entry per occurrence) and its promotion records.",
  parameters: LearningItemInput,
  success: LearningItemDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PromptSearchTool = Tool.make("prompt_search", {
  ...shared,
  description: `Search the project's prompt library: saved prompts and workflows people reuse. Every word of query must appear in a prompt's title or body, in any case; an empty query lists them all. Answers with up to ten matches, active first, then proposed (waiting for a person), then archived (a person put it away: do not propose it again), the most used first within each, and a searchId. Search before prompt_save, which needs a searchId from the last ${PromptStore.SEARCH_WINDOW_MINUTES} minutes, and save only what no match already covers. Omit projectId for the calling thread's project.`,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    query: Schema.String,
  }),
  success: PromptSearchResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PromptSaveTool = Tool.make("prompt_save", {
  ...shared,
  description: `Save a prompt or workflow worth reusing to the project's prompt library, in the project prompt_search looked in. Pass the searchId prompt_search answered with in the last ${PromptStore.SEARCH_WINDOW_MINUTES} minutes; a save without one is refused, so duplicates are checked first. kind is prompt (one message to send) or workflow (steps to follow in order); title is one line; body is markdown of at most 10,000 characters. The prompt is proposed until a person accepts it. Answers with the saved prompt, including its id.`,
  parameters: Schema.Struct({
    searchId: Schema.String,
    kind: PromptKind,
    title: PromptTitle,
    body: PromptBody,
  }),
  success: Prompt,
})
  .annotate(Tool.Title, "Save a prompt")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const PromptGetTool = Tool.make("prompt_get", {
  ...shared,
  description:
    "One prompt from the library by id, as prompt_search lists it, with its latest version's title and body.",
  parameters: Schema.Struct({ id: Schema.Int }),
  success: Prompt,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LearningToolkit = Toolkit.make(
  CorrectionsTool,
  CorrectionTool,
  CorrectionAddTool,
  ItemsTool,
  ItemTool,
  PromptSearchTool,
  PromptSaveTool,
  PromptGetTool,
);

const failure = (error: LearningError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const running = <A>(service: Option.Option<A>) =>
  Option.match(service, {
    onNone: () =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: 'Plugin "learning" is not running.',
        }),
      ),
    onSome: Effect.succeed,
  });

/**
 * The stores are read when the handlers are built, not declared as tool dependencies: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the stores are there.
 */
export const handlers = McpToolAccess.toLayer(
  LearningToolkit,
  Effect.gen(function* () {
    const store = running(yield* Effect.serviceOption(CorrectionStore.CorrectionStore));
    const itemStore = running(yield* Effect.serviceOption(ItemStore.ItemStore));
    const promptStore = running(yield* Effect.serviceOption(PromptStore.PromptStore));
    return {
      learning_corrections: McpToolAccess.reads(({ projectId: given, ...input }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          const corrections = yield* store;
          return yield* corrections.list({ projectId, ...input });
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      learning_correction: McpToolAccess.reads(({ id }) =>
        Effect.gen(function* () {
          yield* readCaller();
          const corrections = yield* store;
          return yield* corrections.get(id);
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      learning_correction_add: McpToolAccess.writes(
        ({ projectId, threadId: givenThread, description, declaredMode }) =>
          Effect.gen(function* () {
            const context = yield* readCaller();
            const threadId = givenThread ?? context.caller?.id;
            if (threadId === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "target_required",
                message: "Pass threadId: this MCP client is not running inside a T3 thread.",
              });
            }
            const corrections = yield* store;
            return yield* corrections.record({
              projectId,
              threadId,
              failureKind: "manual",
              declaredMode,
              description,
              sourceEventIds: [],
              sourceKey: null,
            });
          }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      learning_items: McpToolAccess.reads(({ projectId: given, ...input }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          const items = yield* itemStore;
          return yield* items.list({ projectId, ...input });
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      learning_item: McpToolAccess.reads(({ id }) =>
        Effect.gen(function* () {
          yield* readCaller();
          const items = yield* itemStore;
          return yield* items.get(id);
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      prompt_search: McpToolAccess.reads(({ projectId: given, query }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, given);
          const prompts = yield* promptStore;
          return yield* prompts.search({ projectId, query });
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      prompt_save: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const prompts = yield* promptStore;
          return yield* prompts.propose(input);
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      prompt_get: McpToolAccess.reads(({ id }) =>
        Effect.gen(function* () {
          yield* readCaller();
          const prompts = yield* promptStore;
          return (yield* prompts.get(id)).prompt;
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

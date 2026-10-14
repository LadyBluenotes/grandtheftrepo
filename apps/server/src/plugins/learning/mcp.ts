import {
  LearningCorrection,
  LearningCorrectionDeclareInput,
  LearningCorrectionInput,
  LearningCorrectionsInput,
  LearningDeclaredMode,
  type LearningError,
  LearningItem,
  LearningItemDetail,
  LearningItemInput,
  LearningItemsInput,
  LearningPromotion,
  LearningPromotionReviewInput,
  LearningPromotionRollBackInput,
  OrchestratorMcpFailure,
  ProjectId,
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
    "Record a correction by hand: an instance of work being wrong that no server event caught. Omit threadId for the calling thread; the correction takes the thread's project, and a projectId that differs from it is refused. declaredMode names the failure mode when a reviewer or person named one. Secrets in the description are redacted and it is cut at 500 characters.",
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

const CorrectionDeclareTool = Tool.make("learning_correction_declare", {
  ...shared,
  description:
    "Declare the review failure mode of a correction that has none, such as a pull request review that asked for changes or a thread reopened after it settled, so the next sweep counts it toward that mode's learning item. A provider failure, or a correction that already declares a mode, is refused.",
  parameters: LearningCorrectionDeclareInput,
  success: LearningCorrection,
})
  .annotate(Tool.Title, "Declare a correction's mode")
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
    "One learning item by id, with its evidence (one entry per occurrence), its promotion records (handovers to an owner kind: proposed, in_review, adopted, rejected, rolled_back or failed, and who proposed each), the review verdicts on them and the outcome of each adopted one four weeks on.",
  parameters: LearningItemInput,
  success: LearningItemDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PromotionReviewTool = Tool.make("learning_promotion_review", {
  ...shared,
  description:
    "Review a learning promotion that is in_review, as learning_item lists it: the draft its owner kind's plugin holds (a knowledge page, a policy version or a prompt) is the proposal. verdict adopt adopts it, promotes the item and starts the four-week outcome window; reject turns it down and reopens the item; revise asks for changes and leaves it in review for another verdict. note says why, at most 500 characters, secrets redacted. Refused unless the promotion is in review, when your own thread proposed it (a promotion is reviewed by someone other than its proposer), and adopt while the item is no longer a candidate for that owner kind. From a T3 thread only. Answers with the promotion.",
  parameters: LearningPromotionReviewInput,
  success: LearningPromotion,
})
  .annotate(Tool.Title, "Review a learning promotion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const PromotionRollBackTool = Tool.make("learning_promotion_rollback", {
  ...shared,
  description:
    "Roll back an adopted learning promotion: it becomes rolled_back, its outcome is no longer judged, and its item is open again for a person to route elsewhere or close. The draft in its owner kind's plugin is left as it is. Refused unless the promotion is adopted. From a T3 thread only. Answers with the promotion.",
  parameters: LearningPromotionRollBackInput,
  success: LearningPromotion,
})
  .annotate(Tool.Title, "Roll back a learning promotion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const LearningToolkit = Toolkit.make(
  CorrectionsTool,
  CorrectionTool,
  CorrectionAddTool,
  CorrectionDeclareTool,
  ItemsTool,
  ItemTool,
  PromotionReviewTool,
  PromotionRollBackTool,
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

/** The calling thread as an actor, `thread:<id>`; `what` is refused for a client outside T3. */
const threadActor = (what: string) =>
  Effect.gen(function* () {
    const { caller } = yield* readCaller();
    if (caller === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_credential_required",
        message: `${what} is given by a T3 thread; this MCP client is not running in one.`,
      });
    }
    return `thread:${caller.id}`;
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
      learning_correction_declare: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          yield* readCaller();
          const corrections = yield* store;
          return yield* corrections.declare(input);
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
      // An agent acts as its thread, so the proposer check can tell two agents apart.
      learning_promotion_review: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const reviewer = yield* threadActor("A review");
          const items = yield* itemStore;
          return yield* items.reviewPromotion(input, reviewer);
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
      learning_promotion_rollback: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const actor = yield* threadActor("A rollback");
          const items = yield* itemStore;
          return yield* items.rollBackPromotion(input, actor);
        }).pipe(Effect.catchTags({ LearningError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

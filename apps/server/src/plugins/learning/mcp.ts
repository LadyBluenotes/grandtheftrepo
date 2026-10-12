import {
  LearningCorrection,
  LearningCorrectionInput,
  LearningCorrectionsInput,
  LearningDeclaredMode,
  type LearningError,
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
    "List a project's corrections, recorded instances of work going wrong, created between two ISO timestamps (inclusive). Omit projectId for the calling thread's project; narrow with failureKind: provider_turn_failed, provider_turn_interrupted, changes_requested, reopened_after_settlement, review_verdict or manual.",
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
    "Record a correction by hand: an instance of work being wrong that no server event caught. Omit projectId and threadId for the calling thread. declaredMode names the review failure mode when a reviewer or person named one. Secrets in the description are redacted and it is cut at 500 characters.",
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

export const LearningToolkit = Toolkit.make(CorrectionsTool, CorrectionTool, CorrectionAddTool);

const failure = (error: LearningError) =>
  new OrchestratorMcpFailure({
    code: error.code === "not_found" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/**
 * The store is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the store is there.
 */
export const handlers = McpToolAccess.toLayer(
  LearningToolkit,
  Effect.map(Effect.serviceOption(CorrectionStore.CorrectionStore), (storeOption) => {
    const store = Option.match(storeOption, {
      onNone: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: 'Plugin "learning" is not running.',
          }),
        ),
      onSome: Effect.succeed,
    });
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
        ({ projectId: given, threadId: givenThread, description, declaredMode }) =>
          Effect.gen(function* () {
            const context = yield* readCaller();
            const projectId = yield* resolveProjectId(context, given);
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
    };
  }),
);

import {
  OrchestratorMcpFailure,
  RoutingAdherence,
  RoutingAdherenceInput,
  RoutingTiers,
  RoutingTiersGetInput,
  type RoutingError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as AdherenceService from "./AdherenceService.ts";
import * as TierMapService from "./TierMapService.ts";

const RoutingTiersTool = Tool.make("routing_tiers", {
  description:
    "Which provider instance and model each tier does: cheap, standard or strong. Per tier: resolved (providerInstanceId and model), source (project, environment or builtin), available (false when the catalog no longer offers it), and the environment and project entries behind it. Omit projectId for this thread's project. Models are the ids orchestrator_capabilities lists.",
  parameters: RoutingTiersGetInput,
  success: RoutingTiers,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const RoutingAdherenceTool = Tool.make("routing_adherence", {
  description:
    "Whether the recommended model is the one that ran. Over the recommendations a project made from (inclusive) to (exclusive), ISO instants in UTC: measure is the share whose thread's first run used the recommended provider instance and model, with how many were observed (sampleSize), and state unavailable with the reason below five observed launches, while the event log is still being read, or after an event failed to replay; mismatches lists each recommendation that ran something else, with its thread, tier, recommended and observed entry, time and a one-sentence flag.",
  parameters: RoutingAdherenceInput,
  success: RoutingAdherence,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RoutingToolkit = Toolkit.make(RoutingTiersTool, RoutingAdherenceTool);

const failure = (error: RoutingError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/**
 * The services are read when the handlers are built, not declared as tool dependencies: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the services are there.
 */
export const handlers = McpToolAccess.toLayer(
  RoutingToolkit,
  Effect.gen(function* () {
    const tierMap = yield* Effect.serviceOption(TierMapService.TierMapService);
    const adherence = yield* Effect.serviceOption(AdherenceService.AdherenceService);
    return {
      routing_tiers: McpToolAccess.reads((input: RoutingTiersGetInput) =>
        Effect.gen(function* () {
          const tiers = yield* TierMapService.fromOption(tierMap);
          const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
          return yield* tiers.get({ projectId });
        }).pipe(Effect.catchTags({ RoutingError: (error) => Effect.fail(failure(error)) })),
      ),
      routing_adherence: McpToolAccess.reads((input: RoutingAdherenceInput) =>
        Effect.gen(function* () {
          const report = yield* AdherenceService.fromOption(adherence);
          return yield* report.adherence(input);
        }).pipe(Effect.catchTags({ RoutingError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

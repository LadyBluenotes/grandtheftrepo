import {
  OrchestratorMcpFailure,
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

export const RoutingToolkit = Toolkit.make(RoutingTiersTool);

const failure = (error: RoutingError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "io" || error.code === "inactive" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/**
 * The service is read when the handlers are built, not declared as a tool dependency: plugin
 * services are typed as absent from the server chain, and these tools only register while
 * the plugin is active, which is when the service is there.
 */
export const handlers = McpToolAccess.toLayer(
  RoutingToolkit,
  Effect.map(Effect.serviceOption(TierMapService.TierMapService), (option) => ({
    routing_tiers: McpToolAccess.reads((input: RoutingTiersGetInput) =>
      Effect.gen(function* () {
        const tiers = yield* TierMapService.fromOption(option);
        const projectId = yield* resolveProjectId(yield* readCaller(), input.projectId);
        return yield* tiers.get({ projectId });
      }).pipe(Effect.catchTags({ RoutingError: (error) => Effect.fail(failure(error)) })),
    ),
  })),
);

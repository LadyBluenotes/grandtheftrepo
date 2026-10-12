import { OrchestratorMcpFailure, ProjectId, type PolicyError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PolicyService from "./PolicyService.ts";

const PolicyListTool = Tool.make("policy_list", {
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
  description:
    "List the project's policies and the environment-wide ones (project *): reviewed working rules the server renders into each agent's home instruction file. One line per policy: project/key · version · state (draft, accepted, superseded) · title, then the last delivery per agent (claude, codex, copilot) with its file and when it was installed and verified.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const PolicyToolkit = Toolkit.make(PolicyListTool);

const failure = (error: PolicyError) =>
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
  PolicyToolkit,
  Effect.map(Effect.serviceOption(PolicyService.PolicyService), (serviceOption) => {
    const service = Option.match(serviceOption, {
      onNone: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: 'Plugin "policy" is not running.',
          }),
        ),
      onSome: Effect.succeed,
    });
    return {
      policy_list: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const projectId = yield* resolveProjectId(context, input.projectId);
          const policies = yield* (yield* service).list(projectId);
          if (policies.length === 0) return "No policies.";
          return policies
            .map((policy) =>
              [
                `${policy.projectId}/${policy.key} · v${policy.version} · ${policy.state} · ${policy.title}`,
                ...policy.deliveries.map(
                  (delivery) =>
                    `  ${delivery.agent}: v${delivery.version} ${delivery.path} installed ${delivery.installedAt} verified ${delivery.verifiedAt ?? "never"}`,
                ),
              ].join("\n"),
            )
            .join("\n");
        }).pipe(Effect.catchTags({ PolicyError: (error) => Effect.fail(failure(error)) })),
      ),
    };
  }),
);

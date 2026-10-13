import { OrchestratorMcpFailure, PluginReadiness, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { loadCaller } from "../mcp/threadAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { PluginHost } from "./PluginHost.ts";

const PluginsReadinessTool = Tool.make("plugins_readiness", {
  description:
    "Report why a plugin feature may be quiet: the readiness checklist the Plugins page shows. plugins lists each plugin in registry order with its checks, each with a status (ready, attention, off), one sentence on how it stands, and where a person fixes it (plugins, plugin, board, usage, scheduled_tasks, or null). A plugin that does not run has one off check saying why. projectId defaults to the calling thread's project; outside a thread, without one, the checks that need a project are left out.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  // An object, so the answer is structured content; `plugins` is what `plugins.readiness` answers.
  success: Schema.Struct({ plugins: Schema.Array(PluginReadiness) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ReadinessToolkit = Toolkit.make(PluginsReadinessTool);

/**
 * Answers what `plugins.readiness` answers. The host is always present, so the layer requires it
 * outright; its tag is passed in because `PluginHost.ts` imports this module.
 */
export const handlers = (tag: typeof PluginHost) =>
  McpToolAccess.toLayer(
    ReadinessToolkit,
    Effect.map(tag, (host) => ({
      plugins_readiness: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const projectId = input.projectId ?? (yield* loadCaller()).caller?.projectId ?? null;
          return { plugins: yield* host.readiness(projectId) };
        }),
      ),
    })),
  );
